const {
  AuditLogEvent,
  EmbedBuilder,
  Events,
  OverwriteType,
  PermissionFlagsBits,
} = require('discord.js');
const { getAutomationConfig } = require('./automation-store');

/**
 * Master logging is deliberately independent from the invite tracker.  Discord
 * does not retain deleted message content, so this module keeps a small rolling
 * in-memory snapshot in addition to listening to the normal gateway events.
 * Audit-log attribution is best-effort: Discord only exposes it to bots with
 * View Audit Log, and an audit entry can arrive shortly after its gateway event.
 */

const MASTER_LOG_CONFIG = 'masterLogs';
const CONFIG_CACHE_MS = 15_000;
const AUDIT_ENTRY_MAX_AGE_MS = 20_000;
const AUDIT_LOOKUP_DELAY_MS = 650;
const MESSAGE_SNAPSHOT_LIMIT = 4_000;
const LOG_COLOR = 0x5865f2;
const SUCCESS_COLOR = 0x57f287;
const WARNING_COLOR = 0xfee75c;
const DANGER_COLOR = 0xed4245;

const configCache = new Map();
const auditCache = new Map();
const messageSnapshots = new Map();
const sendQueues = new Map();
const recentlyBanned = new Map();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function truncate(value, length) {
  const text = String(value ?? '—');
  return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}…`;
}

function neutralizeMentions(value) {
  return String(value ?? '').replace(/@/g, '@\u200b');
}

function code(value, length = 900) {
  return `\`${truncate(neutralizeMentions(value), length).replace(/`/g, 'ˋ')}\``;
}

function timestamp(value) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : `<t:${Math.floor(date.getTime() / 1000)}:F>`;
}

function idOf(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : value.id ?? null;
}

function userMention(value) {
  const id = idOf(value);
  return id ? `<@${id}>` : null;
}

function channelMention(value) {
  const id = idOf(value);
  return id ? `<#${id}>` : null;
}

function roleMention(value) {
  const id = idOf(value);
  return id ? `<@&${id}>` : null;
}

function displayUser(user) {
  if (!user) return 'Unknown user';
  return user.tag ?? user.username ?? user.id ?? 'Unknown user';
}

function displayChannel(channel) {
  if (!channel) return 'Unknown channel';
  return channel.name ? `#${channel.name}` : channel.id ?? 'Unknown channel';
}

function validFields(fields = []) {
  return fields
    .filter((field) => field?.name && field.value != null && field.value !== '')
    .slice(0, 25)
    .map((field) => ({
      name: truncate(neutralizeMentions(field.name), 256),
      value: truncate(neutralizeMentions(field.value), 1_024),
      inline: Boolean(field.inline),
    }));
}

/**
 * Creates the common embed used by master, invite, and gender logging.  The
 * mentions themselves are intentionally kept outside of the embed by sendLog.
 */
function createLogEmbed({ title, description, color = LOG_COLOR, fields, footer, timestamp: at }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(truncate(title ?? 'Server Event', 256))
    .setTimestamp(at ?? new Date());

  if (description) embed.setDescription(truncate(neutralizeMentions(description), 4_096));
  const safeFields = validFields(fields);
  if (safeFields.length) embed.addFields(safeFields);
  if (footer) embed.setFooter({ text: truncate(neutralizeMentions(footer), 2_048) });
  return embed;
}

function normalizeMentions(payload) {
  const mentions = [];
  const add = (type, value) => {
    const id = idOf(value);
    if (id) mentions.push({ type, id: String(id) });
  };

  add('user', payload.actorId ?? payload.actor);
  add('user', payload.targetId ?? payload.target);
  add('channel', payload.channelId ?? payload.channel);
  add('role', payload.roleId ?? payload.role);

  for (const mention of payload.mentions ?? []) {
    if (!mention) continue;
    if (typeof mention === 'string') add('user', mention);
    else add(mention.type ?? 'user', mention.id ?? mention.value ?? mention);
  }

  return [...new Map(mentions.map((mention) => [`${mention.type}:${mention.id}`, mention])).values()];
}

function mentionText(mentions) {
  return mentions
    .map((mention) => {
      if (mention.type === 'channel') return channelMention(mention.id);
      if (mention.type === 'role') return roleMention(mention.id);
      return userMention(mention.id);
    })
    .filter(Boolean)
    .join(' • ');
}

async function getMasterLogConfig(guildId, force = false) {
  const cached = configCache.get(guildId);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const value = await getAutomationConfig(guildId, MASTER_LOG_CONFIG);
    configCache.set(guildId, { value, expiresAt: Date.now() + CONFIG_CACHE_MS });
    return value;
  } catch (error) {
    console.error(`Could not read master-log configuration for ${guildId}`, error);
    return null;
  }
}

function invalidateMasterLogConfig(guildId) {
  if (guildId) configCache.delete(guildId);
  else configCache.clear();
}

async function fetchTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const cached = guild.channels.cache.get(channelId);
  const channel = cached ?? await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased?.() && typeof channel.send === 'function' ? channel : null;
}

async function sendLog(guild, channelId, payload) {
  const channel = await fetchTextChannel(guild, channelId);
  if (!channel) return false;

  const mentions = normalizeMentions(payload);
  const content = mentionText(mentions);
  const send = async () => {
    try {
      await channel.send({
        content: content || undefined,
        allowedMentions: { parse: [], repliedUser: false },
        embeds: [createLogEmbed(payload)],
      });
      return true;
    } catch (error) {
      // A short retry handles transient Discord/REST failures. Permission errors
      // are reported once and are not retried forever.
      if (error?.status >= 500 && error?.status < 600) {
        await sleep(1_000);
        try {
          await channel.send({
            content: content || undefined,
            allowedMentions: { parse: [], repliedUser: false },
            embeds: [createLogEmbed(payload)],
          });
          return true;
        } catch (retryError) {
          console.error(`Could not send a log to ${guild.id}/${channel.id}`, retryError);
          return false;
        }
      }
      console.error(`Could not send a log to ${guild.id}/${channel.id}`, error);
      return false;
    }
  };

  // Preserve log order even when several gateway events arrive at once. Discord's
  // REST manager handles rate limits; this queue only serializes our own sends.
  const previous = sendQueues.get(channel.id) ?? Promise.resolve();
  const next = previous.catch(() => false).then(send);
  const tracked = next.finally(() => {
    if (sendQueues.get(channel.id) === tracked) sendQueues.delete(channel.id);
  });
  sendQueues.set(channel.id, tracked);
  return next;
}

/**
 * Public helper for command handlers.  `actor`, `target`, `channel`, and
 * `mentions` are rendered as non-pinging, clickable mentions above the embed.
 */
async function logMaster(guild, payload) {
  if (!guild) return false;
  const config = await getMasterLogConfig(guild.id);
  if (!config?.channelId) return false;
  return sendLog(guild, config.channelId, payload);
}

function pruneAuditCache(guildId) {
  const entries = auditCache.get(guildId) ?? [];
  const cutoff = Date.now() - AUDIT_ENTRY_MAX_AGE_MS;
  const current = entries.filter((entry) => (entry.createdTimestamp ?? 0) >= cutoff);
  if (current.length) auditCache.set(guildId, current);
  else auditCache.delete(guildId);
  return current;
}

function cacheAuditEntry(guild, entry) {
  if (!guild || !entry) return;
  const entries = pruneAuditCache(guild.id);
  if (!entries.some((existing) => existing.id === entry.id)) entries.unshift(entry);
  auditCache.set(guild.id, entries.slice(0, 80));
}

function auditTargetId(entry) {
  return String(entry?.targetId ?? entry?.target?.id ?? '');
}

function auditEntryIsFresh(entry) {
  return Boolean(entry) && Date.now() - (entry.createdTimestamp ?? 0) <= AUDIT_ENTRY_MAX_AGE_MS;
}

function matchesAudit(entry, actions, targetId, predicate) {
  if (!auditEntryIsFresh(entry) || !actions.includes(entry.action)) return false;
  if (targetId && auditTargetId(entry) !== String(targetId)) return false;
  return !predicate || predicate(entry);
}

async function findAuditEntry(guild, actions, targetId, predicate, waitForEntry = true) {
  const validActions = actions.filter((action) => action != null);
  if (!guild || !validActions.length) return null;

  const fromCache = () => pruneAuditCache(guild.id)
    .find((entry) => matchesAudit(entry, validActions, targetId, predicate));

  let entry = fromCache();
  if (entry) return entry;

  if (waitForEntry) {
    await sleep(AUDIT_LOOKUP_DELAY_MS);
    entry = fromCache();
    if (entry) return entry;
  }

  // The cache is populated by GuildAuditLogEntryCreate. Fetching is a fallback
  // for shards/restarts or when that dispatch raced the resource event.
  for (const action of validActions) {
    const logs = await guild.fetchAuditLogs({ type: action, limit: 8 }).catch(() => null);
    const candidate = logs?.entries?.find((item) => matchesAudit(item, [action], targetId, predicate));
    if (candidate) {
      cacheAuditEntry(guild, candidate);
      return candidate;
    }
  }
  return null;
}

async function auditDetails(guild, actions, targetId, predicate, waitForEntry = true) {
  const entry = await findAuditEntry(guild, actions, targetId, predicate, waitForEntry);
  if (!entry) return { entry: null, actorId: null, reason: null };
  return {
    entry,
    actorId: entry.executorId ?? entry.executor?.id ?? null,
    reason: entry.reason ?? null,
  };
}

function permissionsToNames(bitfield) {
  if (bitfield == null) return [];
  let permissions;
  try {
    permissions = BigInt(bitfield);
  } catch {
    return [];
  }
  return Object.entries(PermissionFlagsBits)
    .filter(([, value]) => typeof value === 'bigint' && (permissions & value) === value)
    .map(([name]) => name);
}

function diffPermissions(before, after) {
  const oldNames = new Set(permissionsToNames(before));
  const newNames = new Set(permissionsToNames(after));
  const added = [...newNames].filter((name) => !oldNames.has(name));
  const removed = [...oldNames].filter((name) => !newNames.has(name));
  if (!added.length && !removed.length) return null;
  return [
    added.length ? `Allowed: ${truncate(added.join(', '), 440)}` : null,
    removed.length ? `Removed: ${truncate(removed.join(', '), 440)}` : null,
  ].filter(Boolean).join('\n');
}

function overwriteTargetMention(overwrite) {
  return overwrite?.type === OverwriteType.Member ? userMention(overwrite.id) : roleMention(overwrite?.id);
}

function diffPermissionOverwrites(oldChannel, newChannel) {
  const oldOverwrites = oldChannel?.permissionOverwrites?.cache ?? new Map();
  const newOverwrites = newChannel?.permissionOverwrites?.cache ?? new Map();
  const ids = new Set([...oldOverwrites.keys(), ...newOverwrites.keys()]);
  const changes = [];
  const mentions = [];
  let memberChange = false;
  let roleChange = false;

  for (const id of ids) {
    const before = oldOverwrites.get(id);
    const after = newOverwrites.get(id);
    if (before?.allow?.bitfield === after?.allow?.bitfield && before?.deny?.bitfield === after?.deny?.bitfield) continue;
    const overwrite = after ?? before;
    const target = overwriteTargetMention(overwrite) ?? `ID ${id}`;
    const kind = overwrite?.type === OverwriteType.Member ? 'member' : 'role';
    if (kind === 'member') memberChange = true;
    else roleChange = true;
    mentions.push({ type: kind === 'member' ? 'user' : 'role', id });
    if (!before) {
      changes.push(`Added overwrite for ${target}`);
      continue;
    }
    if (!after) {
      changes.push(`Removed overwrite for ${target}`);
      continue;
    }
    const allows = diffPermissions(before.allow?.bitfield, after.allow?.bitfield);
    const denies = diffPermissions(before.deny?.bitfield, after.deny?.bitfield);
    changes.push(`${target}: ${[allows && `Allow — ${allows}`, denies && `Deny — ${denies}`].filter(Boolean).join('; ') || 'overwrite changed'}`);
  }

  return { changes, mentions, memberChange, roleChange };
}

function fieldChange(label, before, after, formatter = (value) => value ?? 'Not set') {
  const oldValue = formatter(before);
  const newValue = formatter(after);
  if (String(oldValue) === String(newValue)) return null;
  return { name: label, value: `${code(oldValue, 430)} → ${code(newValue, 430)}` };
}

function isThread(channel) {
  return Boolean(channel?.isThread?.());
}

function describeChannelType(channel) {
  if (channel?.isThread?.()) return 'thread';
  if (channel?.isVoiceBased?.()) return 'voice channel';
  if (channel?.isTextBased?.()) return 'text channel';
  return 'channel';
}

function snapshotFor(message) {
  if (!message?.guildId || !message.id) return null;
  const guildSnapshots = messageSnapshots.get(message.guildId) ?? new Map();
  const snapshot = {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author?.id ?? null,
    authorTag: displayUser(message.author),
    content: message.content ?? '',
    url: message.url ?? null,
    attachments: [...(message.attachments?.values?.() ?? [])].map((attachment) => ({
      name: attachment.name ?? 'Attachment',
      url: attachment.url,
      contentType: attachment.contentType ?? null,
    })),
    createdTimestamp: message.createdTimestamp ?? Date.now(),
  };
  guildSnapshots.set(message.id, snapshot);
  while (guildSnapshots.size > MESSAGE_SNAPSHOT_LIMIT) {
    guildSnapshots.delete(guildSnapshots.keys().next().value);
  }
  messageSnapshots.set(message.guildId, guildSnapshots);
  return snapshot;
}

function cachedSnapshot(message) {
  return messageSnapshots.get(message?.guildId)?.get(message?.id) ?? null;
}

function removeSnapshot(message) {
  const snapshots = messageSnapshots.get(message?.guildId);
  if (snapshots) snapshots.delete(message.id);
}

async function hydrateMessage(message) {
  if (!message?.partial) return message;
  return message.fetch().catch(() => message);
}

function attachmentSummary(attachments = []) {
  if (!attachments.length) return null;
  return attachments.slice(0, 10).map((attachment) => attachment.name ?? attachment.url ?? 'Attachment').join(', ');
}

function auditChannelId(entry) {
  return String(
    entry?.extra?.channel?.id
      ?? entry?.extra?.channelId
      ?? entry?.extra?.channel_id
      ?? entry?.targetId
      ?? ''
  );
}

function auditActionLabel(action) {
  const name = Object.entries(AuditLogEvent).find(([, value]) => value === action)?.[0];
  return name ? name.replace(/([a-z])([A-Z])/g, '$1 $2') : `Audit action ${action}`;
}

function auditChanges(entry) {
  return (entry?.changes ?? []).slice(0, 8).map((change) => {
    const before = change.old ?? 'Not set';
    const after = change.new ?? 'Not set';
    return {
      name: truncate(change.key?.replace(/_/g, ' ') ?? 'Changed setting', 256),
      value: `${code(typeof before === 'object' ? JSON.stringify(before) : before, 360)} → ${code(typeof after === 'object' ? JSON.stringify(after) : after, 360)}`,
    };
  });
}

function actionValues(names) {
  return names.map((name) => AuditLogEvent[name]).filter((value) => value != null);
}

const AUDIT_ACTIONS = {
  guildUpdate: actionValues(['GuildUpdate']),
  channelCreate: actionValues(['ChannelCreate']),
  channelDelete: actionValues(['ChannelDelete']),
  channelUpdate: actionValues(['ChannelUpdate']),
  channelOverwrite: actionValues(['ChannelOverwriteCreate', 'ChannelOverwriteUpdate', 'ChannelOverwriteDelete']),
  roleCreate: actionValues(['RoleCreate']),
  roleDelete: actionValues(['RoleDelete']),
  roleUpdate: actionValues(['RoleUpdate']),
  memberKick: actionValues(['MemberKick']),
  memberBanAdd: actionValues(['MemberBanAdd']),
  memberBanRemove: actionValues(['MemberBanRemove']),
  memberUpdate: actionValues(['MemberUpdate', 'MemberRoleUpdate']),
  memberMove: actionValues(['MemberMove', 'MemberDisconnect', 'MemberUpdate']),
  inviteCreate: actionValues(['InviteCreate']),
  inviteDelete: actionValues(['InviteDelete']),
  messageDelete: actionValues(['MessageDelete']),
  messageBulkDelete: actionValues(['MessageBulkDelete']),
  threadCreate: actionValues(['ThreadCreate']),
  threadDelete: actionValues(['ThreadDelete']),
  threadUpdate: actionValues(['ThreadUpdate']),
  emoji: actionValues(['EmojiCreate', 'EmojiDelete', 'EmojiUpdate']),
  sticker: actionValues(['StickerCreate', 'StickerDelete', 'StickerUpdate']),
  scheduledEvent: actionValues(['GuildScheduledEventCreate', 'GuildScheduledEventDelete', 'GuildScheduledEventUpdate']),
  stage: actionValues(['StageInstanceCreate', 'StageInstanceDelete', 'StageInstanceUpdate']),
};

async function withAudit(guild, actions, targetId, predicate) {
  return auditDetails(guild, actions, targetId, predicate);
}

async function logMemberAdd(member) {
  await logMaster(member.guild, {
    title: member.user?.bot ? 'Bot Added' : 'Member Joined',
    description: `${displayUser(member.user)} joined the server.`,
    color: SUCCESS_COLOR,
    target: member.id,
    fields: [
      { name: 'Account', value: code(displayUser(member.user)), inline: true },
      { name: 'Account created', value: timestamp(member.user?.createdTimestamp), inline: true },
    ],
  });
}

async function logMemberRemove(member) {
  const guild = member.guild;
  const details = await withAudit(guild, [...AUDIT_ACTIONS.memberKick, ...AUDIT_ACTIONS.memberBanAdd], member.id);
  if (details.entry?.action === AuditLogEvent.MemberBanAdd || recentlyBanned.get(`${guild.id}:${member.id}`) > Date.now()) {
    return;
  }
  const kicked = details.entry?.action === AuditLogEvent.MemberKick;
  await logMaster(guild, {
    title: kicked ? 'Member Kicked' : (member.user?.bot ? 'Bot Removed' : 'Member Left'),
    description: kicked ? `${displayUser(member.user)} was removed from the server.` : `${displayUser(member.user)} left the server.`,
    color: kicked ? DANGER_COLOR : WARNING_COLOR,
    actor: details.actorId,
    target: member.id,
    fields: [
      { name: 'Member', value: code(displayUser(member.user)), inline: true },
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

function memberRoleChanges(oldMember, newMember) {
  const oldRoles = oldMember.roles?.cache ?? new Map();
  const newRoles = newMember.roles?.cache ?? new Map();
  const added = [...newRoles.keys()].filter((id) => id !== newMember.guild.id && !oldRoles.has(id));
  const removed = [...oldRoles.keys()].filter((id) => id !== newMember.guild.id && !newRoles.has(id));
  return { added, removed };
}

async function logMemberUpdate(oldMember, newMember) {
  const fields = [];
  const roleChanges = memberRoleChanges(oldMember, newMember);
  if (roleChanges.added.length) fields.push({ name: 'Roles added', value: roleChanges.added.map(roleMention).join(', ') });
  if (roleChanges.removed.length) fields.push({ name: 'Roles removed', value: roleChanges.removed.map(roleMention).join(', ') });
  const nickname = fieldChange('Nickname', oldMember.nickname, newMember.nickname);
  if (nickname) fields.push(nickname);
  const timeout = fieldChange(
    'Timeout until',
    oldMember.communicationDisabledUntilTimestamp,
    newMember.communicationDisabledUntilTimestamp,
    timestamp
  );
  if (timeout) fields.push(timeout);
  const boost = fieldChange('Boosting since', oldMember.premiumSinceTimestamp, newMember.premiumSinceTimestamp, timestamp);
  if (boost) fields.push(boost);
  const pending = fieldChange('Membership screening', oldMember.pending, newMember.pending, (value) => value ? 'Pending' : 'Complete');
  if (pending) fields.push(pending);
  const avatar = fieldChange('Server avatar', oldMember.avatar, newMember.avatar, (value) => value ? 'Changed' : 'Not set');
  if (avatar) fields.push(avatar);
  if (!fields.length) return;

  let title = 'Member Updated';
  if ((roleChanges.added.length || roleChanges.removed.length) && fields.length === 1) title = 'User Roles Edited';
  else if (nickname && fields.length === 1) title = 'Nickname Changed';
  else if (timeout && fields.length === 1) title = 'Member Timeout Updated';
  else if (boost && fields.length === 1) title = 'Server Boost Updated';

  const details = await withAudit(newMember.guild, AUDIT_ACTIONS.memberUpdate, newMember.id);
  await logMaster(newMember.guild, {
    title,
    description: `${displayUser(newMember.user)}'s member profile changed.`,
    actor: details.actorId,
    target: newMember.id,
    color: timeout ? WARNING_COLOR : LOG_COLOR,
    fields: [...fields, details.reason ? { name: 'Reason', value: details.reason } : null],
  });
}

async function logBanAdd(ban) {
  const details = await withAudit(ban.guild, AUDIT_ACTIONS.memberBanAdd, ban.user.id);
  recentlyBanned.set(`${ban.guild.id}:${ban.user.id}`, Date.now() + AUDIT_ENTRY_MAX_AGE_MS);
  await logMaster(ban.guild, {
    title: 'Member Banned',
    description: `${displayUser(ban.user)} was banned from the server.`,
    color: DANGER_COLOR,
    actor: details.actorId,
    target: ban.user.id,
    fields: [
      { name: 'Member', value: code(displayUser(ban.user)), inline: true },
      details.reason || ban.reason ? { name: 'Reason', value: details.reason ?? ban.reason } : null,
    ],
  });
}

async function logBanRemove(ban) {
  const details = await withAudit(ban.guild, AUDIT_ACTIONS.memberBanRemove, ban.user.id);
  await logMaster(ban.guild, {
    title: 'Member Unbanned',
    description: `${displayUser(ban.user)} was unbanned.`,
    color: SUCCESS_COLOR,
    actor: details.actorId,
    target: ban.user.id,
    fields: [details.reason ? { name: 'Reason', value: details.reason } : null],
  });
}

async function logRoleCreate(role) {
  const details = await withAudit(role.guild, AUDIT_ACTIONS.roleCreate, role.id);
  await logMaster(role.guild, {
    title: 'Role Created',
    description: `${role.name} was created.`,
    color: SUCCESS_COLOR,
    actor: details.actorId,
    role: role.id,
    fields: [
      { name: 'Role', value: code(role.name), inline: true },
      { name: 'Permissions', value: truncate(permissionsToNames(role.permissions?.bitfield).join(', ') || 'None', 900) },
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

async function logRoleDelete(role) {
  const details = await withAudit(role.guild, AUDIT_ACTIONS.roleDelete, role.id);
  await logMaster(role.guild, {
    title: 'Role Deleted',
    description: `${role.name} was deleted.`,
    color: DANGER_COLOR,
    actor: details.actorId,
    role: role.id,
    fields: [{ name: 'Role', value: code(role.name), inline: true }, details.reason ? { name: 'Reason', value: details.reason } : null],
  });
}

async function logRoleUpdate(oldRole, newRole) {
  const fields = [
    fieldChange('Name', oldRole.name, newRole.name),
    fieldChange('Color', oldRole.hexColor, newRole.hexColor),
    fieldChange('Displayed separately', oldRole.hoist, newRole.hoist, (value) => value ? 'Yes' : 'No'),
    fieldChange('Mentionable', oldRole.mentionable, newRole.mentionable, (value) => value ? 'Yes' : 'No'),
    fieldChange('Position', oldRole.position, newRole.position),
  ].filter(Boolean);
  const permissionChange = diffPermissions(oldRole.permissions?.bitfield, newRole.permissions?.bitfield);
  if (permissionChange) fields.push({ name: 'Permissions', value: permissionChange });
  if (!fields.length) return;
  const details = await withAudit(newRole.guild, AUDIT_ACTIONS.roleUpdate, newRole.id);
  await logMaster(newRole.guild, {
    title: permissionChange && fields.length === 1 ? 'Role Permissions Edited' : 'Role Edited',
    description: `${newRole.name} changed.`,
    actor: details.actorId,
    role: newRole.id,
    fields: [...fields, details.reason ? { name: 'Reason', value: details.reason } : null],
  });
}

async function logGuildUpdate(oldGuild, newGuild) {
  const fields = [
    fieldChange('Name', oldGuild.name, newGuild.name),
    fieldChange('Verification level', oldGuild.verificationLevel, newGuild.verificationLevel),
    fieldChange('Explicit-content filter', oldGuild.explicitContentFilter, newGuild.explicitContentFilter),
    fieldChange('Default notifications', oldGuild.defaultMessageNotifications, newGuild.defaultMessageNotifications),
    fieldChange('AFK channel', oldGuild.afkChannelId, newGuild.afkChannelId, channelMention),
    fieldChange('System channel', oldGuild.systemChannelId, newGuild.systemChannelId, channelMention),
    fieldChange('Rules channel', oldGuild.rulesChannelId, newGuild.rulesChannelId, channelMention),
    fieldChange('Community updates channel', oldGuild.publicUpdatesChannelId, newGuild.publicUpdatesChannelId, channelMention),
    fieldChange('Owner', oldGuild.ownerId, newGuild.ownerId, userMention),
  ].filter(Boolean);
  if (!fields.length) return;
  const details = await withAudit(newGuild, AUDIT_ACTIONS.guildUpdate, newGuild.id);
  await logMaster(newGuild, {
    title: 'Server Settings Edited',
    description: 'Server settings changed.',
    actor: details.actorId,
    fields: [...fields, details.reason ? { name: 'Reason', value: details.reason } : null],
  });
}

async function logChannelCreate(channel) {
  if (isThread(channel)) return;
  const details = await withAudit(channel.guild, AUDIT_ACTIONS.channelCreate, channel.id);
  await logMaster(channel.guild, {
    title: 'Channel Created',
    description: `${displayChannel(channel)} was created.`,
    color: SUCCESS_COLOR,
    actor: details.actorId,
    channel,
    fields: [
      { name: 'Type', value: describeChannelType(channel), inline: true },
      channel.parentId ? { name: 'Category', value: channelMention(channel.parentId), inline: true } : null,
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

async function logChannelDelete(channel) {
  if (isThread(channel)) return;
  const details = await withAudit(channel.guild, AUDIT_ACTIONS.channelDelete, channel.id);
  await logMaster(channel.guild, {
    title: 'Channel Deleted',
    description: `${displayChannel(channel)} was deleted.`,
    color: DANGER_COLOR,
    actor: details.actorId,
    channel,
    fields: [
      { name: 'Name', value: code(channel.name), inline: true },
      { name: 'Type', value: describeChannelType(channel), inline: true },
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

async function logChannelUpdate(oldChannel, newChannel) {
  if (isThread(newChannel) || isThread(oldChannel)) return;
  const fields = [
    fieldChange('Name', oldChannel.name, newChannel.name),
    fieldChange('Topic', oldChannel.topic, newChannel.topic),
    fieldChange('Category', oldChannel.parentId, newChannel.parentId, channelMention),
    fieldChange('NSFW', oldChannel.nsfw, newChannel.nsfw, (value) => value ? 'Enabled' : 'Disabled'),
    fieldChange('Slowmode', oldChannel.rateLimitPerUser, newChannel.rateLimitPerUser, (value) => value ? `${value}s` : 'Disabled'),
    fieldChange('Bitrate', oldChannel.bitrate, newChannel.bitrate, (value) => value ? `${value / 1000} kbps` : 'Not set'),
    fieldChange('User limit', oldChannel.userLimit, newChannel.userLimit, (value) => value || 'Unlimited'),
  ].filter(Boolean);
  const overwriteDiff = diffPermissionOverwrites(oldChannel, newChannel);
  if (overwriteDiff.changes.length) fields.push({ name: 'Permission overwrites', value: truncate(overwriteDiff.changes.join('\n'), 1_000) });
  if (!fields.length) return;
  const actions = overwriteDiff.changes.length && fields.length === 1
    ? AUDIT_ACTIONS.channelOverwrite
    : [...AUDIT_ACTIONS.channelUpdate, ...AUDIT_ACTIONS.channelOverwrite];
  const details = await withAudit(newChannel.guild, actions, newChannel.id);
  const title = overwriteDiff.changes.length && fields.length === 1
    ? (overwriteDiff.memberChange && !overwriteDiff.roleChange ? 'User Permissions Edited' : 'Channel Permissions Edited')
    : 'Channel Edited';
  await logMaster(newChannel.guild, {
    title,
    description: `${displayChannel(newChannel)} changed.`,
    actor: details.actorId,
    channel: newChannel,
    mentions: overwriteDiff.mentions,
    fields: [...fields, details.reason ? { name: 'Reason', value: details.reason } : null],
  });
}

async function logThreadCreate(thread) {
  const details = await withAudit(thread.guild, AUDIT_ACTIONS.threadCreate, thread.id);
  await logMaster(thread.guild, {
    title: 'Thread Created',
    description: `${displayChannel(thread)} was created.`,
    color: SUCCESS_COLOR,
    actor: details.actorId,
    channel: thread,
    mentions: thread.parentId ? [{ type: 'channel', id: thread.parentId }] : [],
    fields: [
      thread.parentId ? { name: 'Parent channel', value: channelMention(thread.parentId), inline: true } : null,
      { name: 'Private', value: thread.type === 12 ? 'Yes' : 'No', inline: true },
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

async function logThreadDelete(thread) {
  const details = await withAudit(thread.guild, AUDIT_ACTIONS.threadDelete, thread.id);
  await logMaster(thread.guild, {
    title: 'Thread Deleted',
    description: `${displayChannel(thread)} was deleted.`,
    color: DANGER_COLOR,
    actor: details.actorId,
    channel: thread,
    mentions: thread.parentId ? [{ type: 'channel', id: thread.parentId }] : [],
    fields: [
      { name: 'Name', value: code(thread.name), inline: true },
      thread.parentId ? { name: 'Parent channel', value: channelMention(thread.parentId), inline: true } : null,
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

async function logThreadUpdate(oldThread, newThread) {
  const fields = [
    fieldChange('Name', oldThread.name, newThread.name),
    fieldChange('Archived', oldThread.archived, newThread.archived, (value) => value ? 'Yes' : 'No'),
    fieldChange('Locked', oldThread.locked, newThread.locked, (value) => value ? 'Yes' : 'No'),
    fieldChange('Auto archive duration', oldThread.autoArchiveDuration, newThread.autoArchiveDuration, (value) => value ? `${value} minutes` : 'Not set'),
    fieldChange('Slowmode', oldThread.rateLimitPerUser, newThread.rateLimitPerUser, (value) => value ? `${value}s` : 'Disabled'),
  ].filter(Boolean);
  if (!fields.length) return;
  const details = await withAudit(newThread.guild, AUDIT_ACTIONS.threadUpdate, newThread.id);
  await logMaster(newThread.guild, {
    title: 'Thread Edited',
    description: `${displayChannel(newThread)} changed.`,
    actor: details.actorId,
    channel: newThread,
    mentions: newThread.parentId ? [{ type: 'channel', id: newThread.parentId }] : [],
    fields: [...fields, details.reason ? { name: 'Reason', value: details.reason } : null],
  });
}

async function logInviteCreate(invite) {
  const details = await withAudit(invite.guild, AUDIT_ACTIONS.inviteCreate, invite.code);
  await logMaster(invite.guild, {
    title: 'Invite Created',
    description: `Invite ${invite.code ? `\`${invite.code}\`` : 'code unavailable'} was created.`,
    color: SUCCESS_COLOR,
    actor: details.actorId ?? invite.inviter?.id,
    channel: invite.channelId,
    fields: [
      { name: 'Code', value: code(invite.code), inline: true },
      invite.inviter ? { name: 'Inviter', value: code(displayUser(invite.inviter)), inline: true } : null,
      invite.maxUses ? { name: 'Maximum uses', value: String(invite.maxUses), inline: true } : null,
      invite.expiresTimestamp ? { name: 'Expires', value: timestamp(invite.expiresTimestamp), inline: true } : null,
    ],
  });
}

async function logInviteDelete(invite) {
  const details = await withAudit(invite.guild, AUDIT_ACTIONS.inviteDelete, invite.code);
  await logMaster(invite.guild, {
    title: 'Invite Deleted',
    description: `Invite ${invite.code ? `\`${invite.code}\`` : 'code unavailable'} was deleted or expired.`,
    color: WARNING_COLOR,
    actor: details.actorId,
    channel: invite.channelId,
    fields: [{ name: 'Code', value: code(invite.code), inline: true }, details.reason ? { name: 'Reason', value: details.reason } : null],
  });
}

async function logMessageCreate(message) {
  if (!message.guild || message.author?.id === message.client.user?.id) return;
  // Keep a local copy solely for a later edit/delete/purge report. Ordinary
  // messages are intentionally not emitted as log entries.
  snapshotFor(message);
}

async function logMessageUpdate(oldMessage, newMessage) {
  const message = await hydrateMessage(newMessage);
  if (!message.guild || message.author?.id === message.client.user?.id) return;
  const snapshot = cachedSnapshot(oldMessage) ?? cachedSnapshot(message) ?? snapshotFor(oldMessage);
  snapshotFor(message);
  const oldContent = oldMessage.content ?? snapshot?.content ?? '[Message content was not cached]';
  const newContent = message.content ?? '[Message content unavailable]';
  const oldAttachments = attachmentSummary(snapshot?.attachments ?? [...(oldMessage.attachments?.values?.() ?? [])]);
  const newAttachments = attachmentSummary([...message.attachments.values()]);
  const fields = [];
  if (oldContent !== newContent) {
    fields.push({ name: 'Before', value: truncate(neutralizeMentions(oldContent) || '[No text]', 950) });
    fields.push({ name: 'After', value: truncate(neutralizeMentions(newContent) || '[No text]', 950) });
  }
  if (oldAttachments !== newAttachments) fields.push({ name: 'Attachments', value: `${oldAttachments ?? 'None'} → ${newAttachments ?? 'None'}` });
  if (!fields.length) return;
  await logMaster(message.guild, {
    title: 'Message Edited',
    description: `${displayUser(message.author)} edited a message in ${channelMention(message.channelId)}.${message.url ? ` [Jump to message](${message.url})` : ''}`,
    actor: message.author?.id,
    channel: message.channelId,
    fields,
  });
}

async function logMessageDelete(message) {
  if (!message.guild) return;
  const snapshot = cachedSnapshot(message);
  const authorId = message.author?.id ?? snapshot?.authorId;
  if (authorId === message.client?.user?.id) {
    removeSnapshot(message);
    return;
  }
  const details = await withAudit(
    message.guild,
    AUDIT_ACTIONS.messageDelete,
    null,
    (entry) => auditChannelId(entry) === String(message.channelId)
  );
  await logMaster(message.guild, {
    title: 'Message Deleted',
    description: `${snapshot?.authorTag ?? displayUser(message.author)}'s message was deleted from ${channelMention(message.channelId)}.`,
    color: DANGER_COLOR,
    actor: details.actorId ?? authorId,
    target: authorId && details.actorId && details.actorId !== authorId ? authorId : null,
    channel: message.channelId,
    fields: [
      authorId ? { name: 'Author', value: code(snapshot?.authorTag ?? displayUser(message.author)), inline: true } : null,
      snapshot?.content || message.content ? { name: 'Deleted content', value: truncate(neutralizeMentions(snapshot?.content ?? message.content), 1_000) } : null,
      attachmentSummary(snapshot?.attachments ?? [...(message.attachments?.values?.() ?? [])]) ? { name: 'Attachments', value: attachmentSummary(snapshot?.attachments ?? [...(message.attachments?.values?.() ?? [])]) } : null,
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
  removeSnapshot(message);
}

async function logBulkDelete(messages, channel) {
  const guild = channel?.guild ?? messages.first()?.guild;
  if (!guild) return;
  const details = await withAudit(
    guild,
    AUDIT_ACTIONS.messageBulkDelete,
    null,
    (entry) => auditChannelId(entry) === String(channel?.id)
  );
  const authors = [...new Set([...messages.values()].map((message) => message.author?.id ?? cachedSnapshot(message)?.authorId).filter(Boolean))];
  const samples = [...messages.values()].slice(0, 5).map((message) => cachedSnapshot(message)?.content ?? message.content).filter(Boolean);
  await logMaster(guild, {
    title: 'Messages Purged',
    description: `${messages.size} messages were bulk-deleted from ${channelMention(channel?.id)}.`,
    color: DANGER_COLOR,
    actor: details.actorId,
    channel: channel?.id,
    mentions: authors.map((id) => ({ type: 'user', id })),
    fields: [
      { name: 'Deleted messages', value: String(messages.size), inline: true },
      authors.length ? { name: 'Affected authors', value: authors.map(userMention).join(', ') } : null,
      samples.length ? { name: 'Content samples', value: truncate(neutralizeMentions(samples.join('\n—\n')), 1_000) } : null,
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
  for (const message of messages.values()) removeSnapshot(message);
}

function voiceFlags(oldState, newState) {
  const changes = [];
  const namedFlags = [
    ['Self mute', 'selfMute'],
    ['Server mute', 'serverMute'],
    ['Self deafen', 'selfDeaf'],
    ['Server deafen', 'serverDeaf'],
    ['Streaming', 'streaming'],
    ['Camera', 'selfVideo'],
    ['Stage suppression', 'suppress'],
  ];
  for (const [label, key] of namedFlags) {
    if (oldState[key] !== newState[key]) {
      changes.push({ name: label, value: newState[key] ? 'Enabled' : 'Disabled', inline: true, serverControlled: key === 'serverMute' || key === 'serverDeaf' || key === 'suppress' });
    }
  }
  if (oldState.requestToSpeakTimestamp !== newState.requestToSpeakTimestamp) {
    changes.push({ name: 'Request to speak', value: newState.requestToSpeakTimestamp ? 'Requested' : 'Cleared', inline: true, serverControlled: false });
  }
  return changes;
}

async function logVoiceUpdate(oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  const member = newState.member ?? oldState.member;
  if (!guild || !member) return;
  const channelChanged = oldState.channelId !== newState.channelId;
  const flags = voiceFlags(oldState, newState);
  if (!channelChanged && !flags.length) return;

  let title = 'Voice State Updated';
  let description = `${displayUser(member.user)}'s voice state changed.`;
  let actions = [];
  if (channelChanged) {
    if (!oldState.channelId) {
      title = 'Voice Channel Joined';
      description = `${displayUser(member.user)} joined ${channelMention(newState.channelId)}.`;
    } else if (!newState.channelId) {
      title = 'Voice Channel Left';
      description = `${displayUser(member.user)} left ${channelMention(oldState.channelId)}.`;
    } else {
      title = 'Voice Channel Moved';
      description = `${displayUser(member.user)} moved from ${channelMention(oldState.channelId)} to ${channelMention(newState.channelId)}.`;
      actions = AUDIT_ACTIONS.memberMove;
    }
  }
  const serverControlled = flags.some((flag) => flag.serverControlled);
  if (!channelChanged && flags.length === 1) title = `${flags[0].name} Changed`;
  if (serverControlled) actions = [...actions, ...AUDIT_ACTIONS.memberMove];
  const details = actions.length ? await withAudit(guild, actions, member.id) : { actorId: member.id, reason: null };
  await logMaster(guild, {
    title,
    description,
    actor: details.actorId ?? member.id,
    target: details.actorId && details.actorId !== member.id ? member.id : null,
    channel: newState.channelId ?? oldState.channelId,
    mentions: oldState.channelId && oldState.channelId !== newState.channelId ? [{ type: 'channel', id: oldState.channelId }] : [],
    fields: [
      channelChanged && oldState.channelId ? { name: 'Previous channel', value: channelMention(oldState.channelId), inline: true } : null,
      channelChanged && newState.channelId ? { name: 'New channel', value: channelMention(newState.channelId), inline: true } : null,
      ...flags.map(({ serverControlled, ...flag }) => flag),
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

async function logEmoji(action, oldEmoji, newEmoji = oldEmoji) {
  const emoji = newEmoji ?? oldEmoji;
  const guild = emoji.guild;
  if (!guild) return;
  const details = await withAudit(guild, AUDIT_ACTIONS.emoji, emoji.id);
  await logMaster(guild, {
    title: `Emoji ${action}`,
    description: `${emoji.name ?? emoji.id} was ${action.toLowerCase()}.`,
    color: action === 'Deleted' ? DANGER_COLOR : action === 'Created' ? SUCCESS_COLOR : LOG_COLOR,
    actor: details.actorId,
    fields: [
      { name: 'Emoji', value: code(emoji.name ?? emoji.id), inline: true },
      oldEmoji && newEmoji && oldEmoji.name !== newEmoji.name ? { name: 'Name', value: `${code(oldEmoji.name)} → ${code(newEmoji.name)}` } : null,
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

async function logSticker(action, oldSticker, newSticker = oldSticker) {
  const sticker = newSticker ?? oldSticker;
  const guild = sticker.guild;
  if (!guild) return;
  const details = await withAudit(guild, AUDIT_ACTIONS.sticker, sticker.id);
  await logMaster(guild, {
    title: `Sticker ${action}`,
    description: `${sticker.name ?? sticker.id} was ${action.toLowerCase()}.`,
    color: action === 'Deleted' ? DANGER_COLOR : action === 'Created' ? SUCCESS_COLOR : LOG_COLOR,
    actor: details.actorId,
    fields: [
      { name: 'Sticker', value: code(sticker.name ?? sticker.id), inline: true },
      oldSticker && newSticker && oldSticker.name !== newSticker.name ? { name: 'Name', value: `${code(oldSticker.name)} → ${code(newSticker.name)}` } : null,
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

async function logScheduledEvent(action, oldEvent, newEvent = oldEvent) {
  const event = newEvent ?? oldEvent;
  const guild = event.guild;
  if (!guild) return;
  const details = await withAudit(guild, AUDIT_ACTIONS.scheduledEvent, event.id);
  const fields = [
    { name: 'Event', value: code(event.name ?? event.id), inline: true },
    event.scheduledStartTimestamp ? { name: 'Starts', value: timestamp(event.scheduledStartTimestamp), inline: true } : null,
    oldEvent && newEvent && oldEvent.name !== newEvent.name ? { name: 'Name', value: `${code(oldEvent.name)} → ${code(newEvent.name)}` } : null,
    details.reason ? { name: 'Reason', value: details.reason } : null,
  ];
  await logMaster(guild, {
    title: `Scheduled Event ${action}`,
    description: `${event.name ?? event.id} was ${action.toLowerCase()}.`,
    color: action === 'Deleted' ? DANGER_COLOR : action === 'Created' ? SUCCESS_COLOR : LOG_COLOR,
    actor: details.actorId,
    fields,
  });
}

async function logStage(action, oldStage, newStage = oldStage) {
  const stage = newStage ?? oldStage;
  const guild = stage.guild;
  if (!guild) return;
  const details = await withAudit(guild, AUDIT_ACTIONS.stage, stage.id);
  await logMaster(guild, {
    title: `Stage Instance ${action}`,
    description: `${stage.topic ?? 'A stage instance'} was ${action.toLowerCase()}.`,
    color: action === 'Deleted' ? DANGER_COLOR : action === 'Created' ? SUCCESS_COLOR : LOG_COLOR,
    actor: details.actorId,
    channel: stage.channelId,
    fields: [
      { name: 'Topic', value: code(stage.topic ?? 'No topic') },
      details.reason ? { name: 'Reason', value: details.reason } : null,
    ],
  });
}

async function logAutoModeration(execution) {
  const guild = execution.guild;
  if (!guild) return;
  await logMaster(guild, {
    title: 'Auto Moderation Triggered',
    description: 'Discord AutoMod took an action.',
    color: WARNING_COLOR,
    target: execution.userId,
    channel: execution.channelId,
    fields: [
      { name: 'Rule ID', value: code(execution.ruleId), inline: true },
      execution.action?.type != null ? { name: 'Action type', value: String(execution.action.type), inline: true } : null,
      execution.matchedKeyword ? { name: 'Matched keyword', value: code(execution.matchedKeyword) } : null,
      execution.matchedContent ? { name: 'Matched content', value: truncate(neutralizeMentions(execution.matchedContent), 900) } : null,
    ],
  });
}

async function logGenericAudit(entry, guild) {
  // Dedicated gateway handlers give much clearer entries for the normal cases.
  // This fills in audit-only actions such as webhooks, integrations, apps, and
  // permission changes Discord does not surface as a richer resource event.
  const dedicated = new Set([
    ...AUDIT_ACTIONS.guildUpdate,
    ...AUDIT_ACTIONS.channelCreate,
    ...AUDIT_ACTIONS.channelDelete,
    ...AUDIT_ACTIONS.channelUpdate,
    ...AUDIT_ACTIONS.channelOverwrite,
    ...AUDIT_ACTIONS.roleCreate,
    ...AUDIT_ACTIONS.roleDelete,
    ...AUDIT_ACTIONS.roleUpdate,
    ...AUDIT_ACTIONS.memberKick,
    ...AUDIT_ACTIONS.memberBanAdd,
    ...AUDIT_ACTIONS.memberBanRemove,
    ...AUDIT_ACTIONS.memberUpdate,
    ...AUDIT_ACTIONS.memberMove,
    ...AUDIT_ACTIONS.inviteCreate,
    ...AUDIT_ACTIONS.inviteDelete,
    ...AUDIT_ACTIONS.messageDelete,
    ...AUDIT_ACTIONS.messageBulkDelete,
    ...AUDIT_ACTIONS.threadCreate,
    ...AUDIT_ACTIONS.threadDelete,
    ...AUDIT_ACTIONS.threadUpdate,
    ...AUDIT_ACTIONS.emoji,
    ...AUDIT_ACTIONS.sticker,
    ...AUDIT_ACTIONS.scheduledEvent,
    ...AUDIT_ACTIONS.stage,
  ]);
  if (dedicated.has(entry.action)) return;
  await logMaster(guild, {
    title: `${auditActionLabel(entry.action)} (Audit)`,
    description: 'Discord recorded an administrative server action.',
    actor: entry.executorId ?? entry.executor?.id,
    target: entry.targetId,
    color: WARNING_COLOR,
    fields: [
      entry.reason ? { name: 'Reason', value: entry.reason } : null,
      ...auditChanges(entry),
    ],
  });
}

function safely(listener, name) {
  return async (...args) => {
    try {
      await listener(...args);
    } catch (error) {
      console.error(`Master logger failed for ${name}`, error);
    }
  };
}

function onEvent(client, event, listener) {
  if (event) client.on(event, safely(listener, event));
}

/**
 * Attaches all feasible Discord.js v14 logging listeners once. The returned
 * helpers are useful to the bot's command handlers for explicit command logs.
 */
function attachMasterLogger(client) {
  if (client.__masterLoggerAttached) {
    return { logMaster, sendLog, createLogEmbed, invalidateMasterLogConfig };
  }
  client.__masterLoggerAttached = true;

  onEvent(client, Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    cacheAuditEntry(guild, entry);
    await logGenericAudit(entry, guild);
  });
  onEvent(client, Events.GuildMemberAdd, logMemberAdd);
  onEvent(client, Events.GuildMemberRemove, logMemberRemove);
  onEvent(client, Events.GuildMemberUpdate, logMemberUpdate);
  onEvent(client, Events.GuildBanAdd, logBanAdd);
  onEvent(client, Events.GuildBanRemove, logBanRemove);
  onEvent(client, Events.GuildRoleCreate, logRoleCreate);
  onEvent(client, Events.GuildRoleDelete, logRoleDelete);
  onEvent(client, Events.GuildRoleUpdate, logRoleUpdate);
  onEvent(client, Events.GuildUpdate, logGuildUpdate);
  onEvent(client, Events.ChannelCreate, logChannelCreate);
  onEvent(client, Events.ChannelDelete, logChannelDelete);
  onEvent(client, Events.ChannelUpdate, logChannelUpdate);
  onEvent(client, Events.ChannelPinsUpdate, async (channel, time) => {
    await logMaster(channel.guild, {
      title: 'Channel Pins Updated',
      description: `Pinned messages changed in ${channelMention(channel.id)}.`,
      channel,
      fields: time ? [{ name: 'Last pin update', value: timestamp(time) }] : [],
    });
  });
  onEvent(client, Events.ThreadCreate, logThreadCreate);
  onEvent(client, Events.ThreadDelete, logThreadDelete);
  onEvent(client, Events.ThreadUpdate, logThreadUpdate);
  onEvent(client, Events.ThreadMembersUpdate, async (addedMembers, removedMembers, thread) => {
    const added = [...(addedMembers?.keys?.() ?? [])];
    const removed = [...(removedMembers?.keys?.() ?? [])];
    if (!added.length && !removed.length) return;
    await logMaster(thread.guild, {
      title: 'Thread Members Updated',
      description: `Membership changed in ${channelMention(thread.id)}.`,
      channel: thread,
      mentions: [...added, ...removed].map((id) => ({ type: 'user', id })),
      fields: [
        added.length ? { name: 'Added', value: added.map(userMention).join(', ') } : null,
        removed.length ? { name: 'Removed', value: removed.map(userMention).join(', ') } : null,
      ],
    });
  });
  onEvent(client, Events.InviteCreate, logInviteCreate);
  onEvent(client, Events.InviteDelete, logInviteDelete);
  onEvent(client, Events.MessageCreate, logMessageCreate);
  onEvent(client, Events.MessageUpdate, logMessageUpdate);
  onEvent(client, Events.MessageDelete, logMessageDelete);
  onEvent(client, Events.MessageBulkDelete, logBulkDelete);
  onEvent(client, Events.VoiceStateUpdate, logVoiceUpdate);
  onEvent(client, Events.GuildEmojiCreate, (emoji) => logEmoji('Created', emoji));
  onEvent(client, Events.GuildEmojiDelete, (emoji) => logEmoji('Deleted', emoji));
  onEvent(client, Events.GuildEmojiUpdate, (oldEmoji, newEmoji) => logEmoji('Edited', oldEmoji, newEmoji));
  onEvent(client, Events.GuildStickerCreate, (sticker) => logSticker('Created', sticker));
  onEvent(client, Events.GuildStickerDelete, (sticker) => logSticker('Deleted', sticker));
  onEvent(client, Events.GuildStickerUpdate, (oldSticker, newSticker) => logSticker('Edited', oldSticker, newSticker));
  onEvent(client, Events.GuildScheduledEventCreate, (event) => logScheduledEvent('Created', event));
  onEvent(client, Events.GuildScheduledEventDelete, (event) => logScheduledEvent('Deleted', event));
  onEvent(client, Events.GuildScheduledEventUpdate, (oldEvent, newEvent) => logScheduledEvent('Edited', oldEvent, newEvent));
  onEvent(client, Events.StageInstanceCreate, (stage) => logStage('Created', stage));
  onEvent(client, Events.StageInstanceDelete, (stage) => logStage('Deleted', stage));
  onEvent(client, Events.StageInstanceUpdate, (oldStage, newStage) => logStage('Edited', oldStage, newStage));
  onEvent(client, Events.AutoModerationActionExecution, logAutoModeration);
  onEvent(client, Events.GuildIntegrationsUpdate, async (guild) => {
    await logMaster(guild, { title: 'Server Integrations Updated', description: 'An integration was added, removed, or updated.', color: WARNING_COLOR });
  });
  onEvent(client, Events.WebhooksUpdate, async (channel) => {
    const details = await withAudit(channel.guild, actionValues(['WebhookCreate', 'WebhookDelete', 'WebhookUpdate']), null);
    await logMaster(channel.guild, {
      title: 'Webhooks Updated',
      description: `Webhook settings changed in ${channelMention(channel.id)}.`,
      color: WARNING_COLOR,
      actor: details.actorId,
      channel,
      fields: [details.reason ? { name: 'Reason', value: details.reason } : null],
    });
  });

  return { logMaster, sendLog, createLogEmbed, invalidateMasterLogConfig };
}

module.exports = {
  attachMasterLogger,
  channelMention,
  createLogEmbed,
  invalidateMasterLogConfig,
  logMaster,
  roleMention,
  sendLog,
  userMention,
};
