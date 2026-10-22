const { EmbedBuilder, Events, PermissionFlagsBits } = require('discord.js');
const {
  getAutomationConfig,
  setAutomationConfig,
} = require('./automation-store');

// Gender logging is deliberately configured by channel rather than by role.  A
// member can use several areas of a server, while a channel has one clear
// audience.  This also avoids exposing male-channel activity in female logs
// (or vice versa) simply because a member's roles changed.
const GENDERS = Object.freeze({
  male: { label: 'Male', color: 0x3b82f6 },
  female: { label: 'Female', color: 0xec4899 },
});

const MAX_EMBED_FIELD = 1024;
const MAX_EMBED_DESCRIPTION = 4096;
const CONFIG_CACHE_TTL_MS = 15_000;
const MESSAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_CACHE_LIMIT = 12_000;
const configCache = new Map();
const messageCache = new Map();
const sendQueues = new Map();

function emptyConfig() {
  return {
    male: { logChannelId: null, channelIds: [] },
    female: { logChannelId: null, channelIds: [] },
  };
}

function normalizeChannelIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter((id) => typeof id === 'string'))];
}

function normalizeConfig(value) {
  const config = emptyConfig();
  for (const gender of Object.keys(GENDERS)) {
    const raw = value?.[gender] ?? {};
    config[gender] = {
      logChannelId: typeof raw.logChannelId === 'string' ? raw.logChannelId : null,
      channelIds: normalizeChannelIds(raw.channelIds),
    };
  }
  return config;
}

async function getGenderLogConfig(guildId, { fresh = false } = {}) {
  const cached = configCache.get(guildId);
  if (!fresh && cached && Date.now() - cached.loadedAt < CONFIG_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = normalizeConfig(await getAutomationConfig(guildId, 'genderLogs'));
  configCache.set(guildId, { value, loadedAt: Date.now() });
  return value;
}

async function saveGenderLogConfig(guildId, config) {
  const normalized = normalizeConfig(config);
  await setAutomationConfig(guildId, 'genderLogs', normalized);
  configCache.set(guildId, { value: normalized, loadedAt: Date.now() });
  return normalized;
}

function truncate(value, maximum) {
  const text = String(value ?? '');
  return text.length > maximum ? `${text.slice(0, Math.max(0, maximum - 1))}…` : text;
}

function cleanLogText(value, maximum = MAX_EMBED_FIELD) {
  const text = String(value ?? '').replace(/@/g, '@\u200b').trim();
  return truncate(text || 'None', maximum);
}

function userMention(userOrId) {
  const id = typeof userOrId === 'string' ? userOrId : userOrId?.id;
  return id ? `<@${id}>` : null;
}

function channelMention(channelOrId) {
  const id = typeof channelOrId === 'string' ? channelOrId : channelOrId?.id;
  return id ? `<#${id}>` : null;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function formatUser(user) {
  if (!user) return 'Unknown user';
  const tag = user.tag ?? user.username ?? 'Unknown user';
  return `${tag} (${user.id ?? 'unknown ID'})`;
}

function formatChannel(channel) {
  if (!channel) return 'Unknown channel';
  return channel.name ? `#${channel.name} (${channel.id})` : String(channel.id ?? 'Unknown channel');
}

function createGenderEmbed(gender, entry) {
  const genderInfo = GENDERS[gender] ?? { label: gender, color: 0x5865f2 };
  const embed = new EmbedBuilder()
    .setColor(entry.color ?? genderInfo.color)
    .setTitle(truncate(entry.title ?? 'Server activity', 256))
    .setTimestamp(entry.timestamp ?? new Date())
    .setFooter({ text: `${genderInfo.label} logs` });

  if (entry.description) {
    embed.setDescription(cleanLogText(entry.description, MAX_EMBED_DESCRIPTION));
  }

  const fields = (entry.fields ?? [])
    .filter((field) => field?.name && field?.value != null)
    .slice(0, 25)
    .map((field) => ({
      name: truncate(field.name, 256),
      value: cleanLogText(field.value, MAX_EMBED_FIELD),
      inline: Boolean(field.inline),
    }));
  if (fields.length) embed.addFields(fields);
  return embed;
}

async function getTextChannel(guild, channelId) {
  if (!channelId) return null;
  const cached = guild.channels.cache.get(channelId);
  if (cached?.isTextBased?.() && cached.send) return cached;
  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  return fetched?.isTextBased?.() && fetched.send ? fetched : null;
}

/**
 * Send one gender log event. Mentions are intentionally outside the embed so
 * moderators can open user/channel profiles directly. allowedMentions blocks
 * notification spam while leaving the mentions clickable.
 */
async function sendGenderLog(guild, gender, entry) {
  if (!guild || !GENDERS[gender]) return false;
  const config = await getGenderLogConfig(guild.id);
  const channelId = config[gender].logChannelId;
  if (!channelId) return false;

  const destination = await getTextChannel(guild, channelId);
  if (!destination) {
    console.warn(`Gender log destination ${channelId} is unavailable in guild ${guild.id}.`);
    return false;
  }

  const userIds = dedupe(asArray(entry.userIds ?? entry.users).map((user) => typeof user === 'string' ? user : user?.id));
  const channelIds = dedupe(asArray(entry.channelIds ?? entry.channels).map((channel) => typeof channel === 'string' ? channel : channel?.id));
  const content = [...userIds.map(userMention), ...channelIds.map(channelMention)].filter(Boolean).join(' ');
  const payload = {
    content: content || undefined,
    allowedMentions: { parse: [] },
    embeds: [createGenderEmbed(gender, entry)],
  };

  // Preserve ordering without allowing one failed send to poison later logs.
  const queueKey = `${guild.id}:${gender}`;
  const previous = sendQueues.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => null)
    .then(() => destination.send(payload));
  sendQueues.set(queueKey, next);
  try {
    await next;
    return true;
  } catch (error) {
    console.error(`Could not send ${gender} log in guild ${guild.id}:`, error);
    return false;
  } finally {
    if (sendQueues.get(queueKey) === next) sendQueues.delete(queueKey);
  }
}

function configuredGenderForId(config, channelId) {
  if (!channelId) return null;
  for (const gender of Object.keys(GENDERS)) {
    if (config[gender].channelIds.includes(channelId)) return gender;
  }
  return null;
}

/** Resolve a direct mapping or a parent category/thread mapping. */
async function getConfiguredGender(guild, channelOrId) {
  if (!guild || !channelOrId) return null;
  const config = await getGenderLogConfig(guild.id);
  let channel = typeof channelOrId === 'string'
    ? guild.channels.cache.get(channelOrId) ?? await guild.channels.fetch(channelOrId).catch(() => null)
    : channelOrId;
  let channelId = typeof channelOrId === 'string' ? channelOrId : channelOrId.id;

  for (let depth = 0; channelId && depth < 5; depth += 1) {
    const gender = configuredGenderForId(config, channelId);
    if (gender) return gender;
    const parentId = channel?.parentId;
    if (!parentId || parentId === channelId) break;
    channelId = parentId;
    channel = guild.channels.cache.get(parentId) ?? await guild.channels.fetch(parentId).catch(() => null);
  }
  return null;
}

function cacheMessage(message) {
  if (!message?.id || !message.guildId) return;
  messageCache.set(message.id, {
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author?.id ?? null,
    authorTag: message.author?.tag ?? message.author?.username ?? null,
    content: message.content ?? '',
    attachments: [...(message.attachments?.values?.() ?? [])].map((attachment) => attachment.url),
    createdTimestamp: message.createdTimestamp ?? Date.now(),
    cachedAt: Date.now(),
  });

  // A bounded cache means a high-volume server cannot exhaust the process.
  while (messageCache.size > MESSAGE_CACHE_LIMIT) {
    const oldestKey = messageCache.keys().next().value;
    messageCache.delete(oldestKey);
  }
}

function cleanupMessageCache() {
  const cutoff = Date.now() - MESSAGE_CACHE_TTL_MS;
  for (const [id, snapshot] of messageCache) {
    if (snapshot.cachedAt < cutoff) messageCache.delete(id);
  }
}

function messageSnapshot(message) {
  const cached = message?.id ? messageCache.get(message.id) : null;
  return cached ?? {
    guildId: message?.guildId ?? message?.guild?.id ?? null,
    channelId: message?.channelId ?? message?.channel?.id ?? null,
    authorId: message?.author?.id ?? null,
    authorTag: message?.author?.tag ?? message?.author?.username ?? null,
    content: message?.content ?? '',
    attachments: [...(message?.attachments?.values?.() ?? [])].map((attachment) => attachment.url),
  };
}

function attachmentSummary(attachments) {
  if (!attachments?.length) return 'None';
  return `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`;
}

async function handleMessageCreate(message) {
  if (!message.guild || message.author?.bot) return;
  const gender = await getConfiguredGender(message.guild, message.channel);
  if (!gender) return;
  // A snapshot makes later edit/delete logs useful without flooding the gender
  // log with every ordinary message sent in the channel.
  cacheMessage(message);
}

async function handleMessageUpdate(oldMessage, newMessage) {
  const guild = newMessage.guild ?? oldMessage.guild;
  if (!guild) return;
  const channel = newMessage.channel ?? oldMessage.channel;
  const gender = await getConfiguredGender(guild, channel ?? newMessage.channelId ?? oldMessage.channelId);
  if (!gender) return;

  const previous = messageSnapshot(oldMessage);
  let currentMessage = newMessage;
  if (currentMessage.partial) currentMessage = await currentMessage.fetch().catch(() => currentMessage);
  const current = messageSnapshot(currentMessage);
  const oldContent = previous.content ?? '';
  const newContent = current.content ?? '';
  const oldAttachments = previous.attachments ?? [];
  const newAttachments = current.attachments ?? [];

  // Discord can emit an update for flags, polls, pins, and other metadata. The
  // message-change log focuses on content/attachment changes so it stays useful.
  if (oldContent === newContent && attachmentSummary(oldAttachments) === attachmentSummary(newAttachments)) {
    cacheMessage(currentMessage);
    return;
  }

  await sendGenderLog(guild, gender, {
    title: 'Message Edited',
    userIds: current.authorId ?? previous.authorId,
    channelIds: current.channelId ?? previous.channelId,
    fields: [
      { name: 'Author', value: current.authorTag ?? previous.authorTag ?? 'Unknown user', inline: true },
      { name: 'Channel', value: formatChannel(channel), inline: true },
      { name: 'Before', value: oldContent || '[no text]' },
      { name: 'After', value: newContent || '[no text]' },
      { name: 'Attachments', value: `${attachmentSummary(oldAttachments)} → ${attachmentSummary(newAttachments)}` },
      { name: 'Message', value: currentMessage.url ?? oldMessage.url ?? 'Unavailable' },
    ],
  });
  cacheMessage(currentMessage);
}

async function handleMessageDelete(message) {
  const guild = message.guild;
  if (!guild) return;
  const snapshot = messageSnapshot(message);
  const gender = await getConfiguredGender(guild, message.channel ?? snapshot.channelId);
  if (!gender) return;

  await sendGenderLog(guild, gender, {
    title: 'Message Deleted',
    userIds: snapshot.authorId,
    channelIds: snapshot.channelId,
    fields: [
      { name: 'Author', value: snapshot.authorTag ?? 'Unknown (message was not cached)', inline: true },
      { name: 'Channel', value: formatChannel(message.channel ?? { id: snapshot.channelId }), inline: true },
      { name: 'Content', value: snapshot.content || '[content unavailable or empty]' },
      { name: 'Attachments', value: attachmentSummary(snapshot.attachments) },
      { name: 'Message ID', value: message.id ?? 'Unavailable' },
    ],
  });
  if (message.id) messageCache.delete(message.id);
}

async function handleMessageBulkDelete(messages, channel) {
  const guild = channel?.guild;
  if (!guild) return;
  const gender = await getConfiguredGender(guild, channel);
  if (!gender) return;

  const records = [...messages.values()].map(messageSnapshot);
  const authorIds = dedupe(records.map((record) => record.authorId)).slice(0, 10);
  const authors = dedupe(records.map((record) => record.authorTag).filter(Boolean));
  await sendGenderLog(guild, gender, {
    title: 'Messages Purged',
    userIds: authorIds,
    channelIds: channel.id,
    fields: [
      { name: 'Channel', value: formatChannel(channel), inline: true },
      { name: 'Deleted messages', value: String(messages.size), inline: true },
      { name: 'Known authors', value: authors.length ? cleanLogText(authors.slice(0, 20).join(', ')) : 'Unavailable (messages were not cached)' },
    ],
  });
  for (const message of messages.values()) messageCache.delete(message.id);
}

function voiceStateChanges(oldState, newState) {
  const checks = [
    ['serverMute', 'Voice Server Muted', 'Voice Server Unmuted'],
    ['selfMute', 'Voice Self Muted', 'Voice Self Unmuted'],
    ['serverDeaf', 'Voice Server Deafened', 'Voice Server Undeafened'],
    ['selfDeaf', 'Voice Self Deafened', 'Voice Self Undeafened'],
    ['streaming', 'Voice Stream Started', 'Voice Stream Stopped'],
    ['selfVideo', 'Voice Video Started', 'Voice Video Stopped'],
    ['suppress', 'Stage Speaker Suppressed', 'Stage Speaker Unsuppressed'],
  ];
  return checks
    .filter(([property]) => oldState[property] !== newState[property])
    .map(([property, becameTrue, becameFalse]) => ({ property, title: newState[property] ? becameTrue : becameFalse }));
}

async function sendVoiceEvent(guild, gender, title, member, channel, extra = []) {
  await sendGenderLog(guild, gender, {
    title,
    userIds: member?.id,
    channelIds: channel?.id,
    fields: [
      { name: 'Member', value: formatUser(member?.user ?? member), inline: true },
      { name: 'Voice channel', value: formatChannel(channel), inline: true },
      ...extra,
    ],
  });
}

async function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;
  const oldGender = oldChannel ? await getConfiguredGender(guild, oldChannel) : null;
  const newGender = newChannel ? await getConfiguredGender(guild, newChannel) : null;
  const member = newState.member ?? oldState.member;

  if (oldState.channelId !== newState.channelId) {
    if (!oldChannel && newChannel && newGender) {
      await sendVoiceEvent(guild, newGender, 'Voice Channel Joined', member, newChannel);
    } else if (oldChannel && !newChannel && oldGender) {
      await sendVoiceEvent(guild, oldGender, 'Voice Channel Left', member, oldChannel);
    } else if (oldChannel && newChannel) {
      if (oldGender && oldGender === newGender) {
        await sendGenderLog(guild, oldGender, {
          title: 'Voice Channel Moved',
          userIds: member?.id,
          channelIds: [oldChannel.id, newChannel.id],
          fields: [
            { name: 'Member', value: formatUser(member?.user ?? member), inline: true },
            { name: 'From', value: formatChannel(oldChannel), inline: true },
            { name: 'To', value: formatChannel(newChannel), inline: true },
          ],
        });
      } else {
        // Do not reveal a destination in the other gender's logs. Each side
        // receives only the join/leave information that belongs to its area.
        if (oldGender) await sendVoiceEvent(guild, oldGender, 'Voice Channel Left', member, oldChannel);
        if (newGender) await sendVoiceEvent(guild, newGender, 'Voice Channel Joined', member, newChannel);
      }
    }
  }

  const currentGender = newGender ?? oldGender;
  const currentChannel = newChannel ?? oldChannel;
  if (!currentGender || !currentChannel) return;
  for (const change of voiceStateChanges(oldState, newState)) {
    await sendVoiceEvent(guild, currentGender, change.title, member, currentChannel);
  }
}

function threadParent(thread) {
  return thread.parent ?? thread.guild?.channels.cache.get(thread.parentId) ?? null;
}

async function handleThreadEvent(title, thread, oldThread = null) {
  const guild = thread.guild ?? oldThread?.guild;
  if (!guild) return;
  const channel = thread ?? oldThread;
  const gender = await getConfiguredGender(guild, channel);
  if (!gender) return;
  const parent = threadParent(channel);
  await sendGenderLog(guild, gender, {
    title,
    userIds: channel.ownerId,
    channelIds: [channel.id, parent?.id],
    fields: [
      { name: 'Thread', value: formatChannel(channel), inline: true },
      { name: 'Parent', value: formatChannel(parent), inline: true },
      { name: 'Owner', value: channel.ownerId ? `<@${channel.ownerId}>` : 'Unavailable', inline: true },
    ],
  });
}

async function handleThreadUpdate(oldThread, newThread) {
  const guild = newThread.guild ?? oldThread.guild;
  if (!guild) return;
  const gender = await getConfiguredGender(guild, newThread);
  if (!gender) return;
  const changes = [];
  if (oldThread.name !== newThread.name) changes.push(`Name: ${oldThread.name} → ${newThread.name}`);
  if (oldThread.archived !== newThread.archived) changes.push(`Archived: ${Boolean(oldThread.archived)} → ${Boolean(newThread.archived)}`);
  if (oldThread.locked !== newThread.locked) changes.push(`Locked: ${Boolean(oldThread.locked)} → ${Boolean(newThread.locked)}`);
  if (!changes.length) return;
  await sendGenderLog(guild, gender, {
    title: 'Thread Edited',
    userIds: newThread.ownerId,
    channelIds: [newThread.id, newThread.parentId],
    fields: [
      { name: 'Thread', value: formatChannel(newThread), inline: true },
      { name: 'Changes', value: changes.join('\n') },
    ],
  });
}

/**
 * Record a moderation action only after the command has actually succeeded.
 * The command handler supplies the final title/details, which avoids logs that
 * incorrectly claim a punishment was applied when Discord rejected it.
 */
async function logGenderModeration(interaction, {
  title,
  target = null,
  description,
  color,
  fields = [],
} = {}) {
  if (!interaction?.guild || !interaction.channel) return false;
  const gender = await getConfiguredGender(interaction.guild, interaction.channel);
  if (!gender) return false;
  const targetId = typeof target === 'string' ? target : target?.id;
  return sendGenderLog(interaction.guild, gender, {
    title: title ?? 'Moderation Action Applied',
    description,
    color,
    userIds: [interaction.user?.id, targetId],
    channelIds: interaction.channelId,
    fields: [
      { name: 'Moderator', value: formatUser(interaction.user), inline: true },
      ...(targetId ? [{ name: 'Target', value: targetId === target ? `User ID: ${targetId}` : formatUser(target), inline: true }] : []),
      { name: 'Channel', value: formatChannel(interaction.channel), inline: true },
      ...fields,
    ],
  });
}

function hasAdministrator(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

async function validateLogDestination(interaction, channel) {
  if (!channel?.isTextBased?.() || !channel.send) {
    await interaction.editReply({ content: 'Choose a text channel where I can send embeds.' });
    return false;
  }
  const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    await interaction.editReply({ content: `I need View Channel, Send Messages, and Embed Links in ${channel}.` });
    return false;
  }
  return true;
}

async function handleGenderLogsCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  if (!hasAdministrator(interaction)) {
    await interaction.editReply({ content: 'Only administrators can configure gender logs.' });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const config = await getGenderLogConfig(interaction.guild.id, { fresh: true });
  if (subcommand === 'status') {
    const lines = Object.entries(GENDERS).map(([gender, info]) => {
      const setting = config[gender];
      return `• **${info.label}** — destination: ${setting.logChannelId ? `<#${setting.logChannelId}>` : 'not configured'}; watched channels: ${setting.channelIds.length}`;
    });
    await interaction.editReply({ content: lines.join('\n') });
    return;
  }

  const gender = interaction.options.getString('gender', true);
  if (!GENDERS[gender]) {
    await interaction.editReply({ content: 'Choose either male or female.' });
    return;
  }

  if (subcommand === 'disable') {
    config[gender].logChannelId = null;
    await saveGenderLogConfig(interaction.guild.id, config);
    await interaction.editReply({ content: `${GENDERS[gender].label} logs are disabled. Watched channel assignments were kept.` });
    return;
  }

  if (subcommand === 'test') {
    if (!config[gender].logChannelId) {
      await interaction.editReply({ content: `Set up a ${GENDERS[gender].label.toLowerCase()} log destination first.` });
      return;
    }
    const sent = await sendGenderLog(interaction.guild, gender, {
      title: `${GENDERS[gender].label} Logs Test`,
      userIds: interaction.user.id,
      channelIds: interaction.channelId,
      fields: [
        { name: 'Configured by', value: formatUser(interaction.user), inline: true },
        { name: 'Result', value: 'If you can see this embed, the destination is ready.' },
      ],
    });
    await interaction.editReply({ content: sent ? 'Test embed sent.' : 'I could not send the test embed; check the channel and my permissions.' });
    return;
  }

  const channel = interaction.options.getChannel('channel', true);
  if (!await validateLogDestination(interaction, channel)) return;
  config[gender].logChannelId = channel.id;
  // A logging channel should not be a watched source. This prevents a setup
  // mistake from causing logs about the logging channel itself.
  for (const key of Object.keys(GENDERS)) {
    config[key].channelIds = config[key].channelIds.filter((id) => id !== channel.id);
  }
  await saveGenderLogConfig(interaction.guild.id, config);
  await interaction.editReply({
    content: `${GENDERS[gender].label} logs will be sent to ${channel}. Now use /${gender} add to assign source channels.`,
  });
}

async function handleGenderSourceCommand(interaction, gender) {
  await interaction.deferReply({ ephemeral: true });
  if (!hasAdministrator(interaction)) {
    await interaction.editReply({ content: 'Only administrators can configure gender log channels.' });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const config = await getGenderLogConfig(interaction.guild.id, { fresh: true });
  if (subcommand === 'list') {
    const ids = config[gender].channelIds;
    await interaction.editReply({
      content: ids.length
        ? `**${GENDERS[gender].label} watched channels**\n${ids.map((id) => `• <#${id}>`).join('\n')}`
        : `No channels are assigned to ${GENDERS[gender].label.toLowerCase()} logs. Use /${gender} add.`,
    });
    return;
  }

  const channel = interaction.options.getChannel('channel', true);
  const destinationIds = new Set(Object.values(config).map((entry) => entry.logChannelId).filter(Boolean));
  if (subcommand === 'add') {
    if (destinationIds.has(channel.id)) {
      await interaction.editReply({ content: `${channel} is a log destination and cannot also be a watched source.` });
      return;
    }
    config[gender].channelIds = normalizeChannelIds([...config[gender].channelIds, channel.id]);
    const other = gender === 'male' ? 'female' : 'male';
    config[other].channelIds = config[other].channelIds.filter((id) => id !== channel.id);
    await saveGenderLogConfig(interaction.guild.id, config);
    await interaction.editReply({ content: `${channel} is now routed to ${GENDERS[gender].label.toLowerCase()} logs. Categories also cover their child channels and threads.` });
    return;
  }

  const before = config[gender].channelIds.length;
  config[gender].channelIds = config[gender].channelIds.filter((id) => id !== channel.id);
  await saveGenderLogConfig(interaction.guild.id, config);
  await interaction.editReply({
    content: before === config[gender].channelIds.length
      ? `${channel} was not assigned to ${GENDERS[gender].label.toLowerCase()} logs.`
      : `${channel} is no longer routed to ${GENDERS[gender].label.toLowerCase()} logs.`,
  });
}

function attachGenderLogger(client) {
  if (client.__genderLoggerAttached) return;
  client.__genderLoggerAttached = true;
  client.on(Events.MessageCreate, (message) => {
    handleMessageCreate(message).catch((error) => console.error('Gender message-cache handler failed', error));
  });
  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    handleMessageUpdate(oldMessage, newMessage).catch((error) => console.error('Gender message-update log failed', error));
  });
  client.on(Events.MessageDelete, (message) => {
    handleMessageDelete(message).catch((error) => console.error('Gender message-delete log failed', error));
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    handleMessageBulkDelete(messages, channel).catch((error) => console.error('Gender bulk-delete log failed', error));
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceStateUpdate(oldState, newState).catch((error) => console.error('Gender voice log failed', error));
  });
  client.on(Events.ThreadCreate, (thread) => {
    handleThreadEvent('Thread Created', thread).catch((error) => console.error('Gender thread-create log failed', error));
  });
  client.on(Events.ThreadDelete, (thread) => {
    handleThreadEvent('Thread Deleted', thread).catch((error) => console.error('Gender thread-delete log failed', error));
  });
  client.on(Events.ThreadUpdate, (oldThread, newThread) => {
    handleThreadUpdate(oldThread, newThread).catch((error) => console.error('Gender thread-update log failed', error));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand?.()) return;
    const handler = interaction.commandName === 'genderlogs'
      ? handleGenderLogsCommand(interaction)
      : interaction.commandName === 'male'
        ? handleGenderSourceCommand(interaction, 'male')
        : interaction.commandName === 'female'
          ? handleGenderSourceCommand(interaction, 'female')
          : null;
    if (!handler) return;
    handler.catch((error) => {
      console.error('Gender interaction handler failed', error);
      if (interaction.deferred || interaction.replied) {
        interaction.followUp({ content: 'Something went wrong while handling gender logs.', ephemeral: true }).catch(() => null);
      } else {
        interaction.reply({ content: 'Something went wrong while handling gender logs.', ephemeral: true }).catch(() => null);
      }
    });
  });

  // Keeping snapshots for a day makes delete logs useful even when Discord
  // supplies a partial message. The timer is unref'd so it never keeps the bot
  // alive by itself during shutdown.
  const cleanup = setInterval(cleanupMessageCache, 60 * 60 * 1000);
  cleanup.unref?.();
}

module.exports = {
  attachGenderLogger,
  getConfiguredGender,
  getGenderLogConfig,
  logGenderModeration,
  sendGenderLog,
};
