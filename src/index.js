require('dotenv').config();

const {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');
const { deployCommands } = require('./deploy-commands');
const {
  addUserPoints,
  getLeaderboard,
  getUserPoints,
  removeUserPoints,
  transferPoints,
} = require('./points-store');
const {
  clearActivePunishment,
  getActivePunishment,
  setActivePunishment,
} = require('./punishments-store');

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN must be set in .env');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const POINT_SYMBOL = 'SSP';
const LEADERBOARD_TITLE = 'Sunnah Shield Points | نقاط درع السنة';
const DEEPFRY_LABEL = 'Deepfry';
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const STAFF_COMMAND_MIN_LEVEL = 30;
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const ROLE_IDS = {
  member: '1149168371984777287',
  male: '1233035143837515897',
  female: '1233035238930907308',
  femaleNonMuslim: '1471869082918715605',
  grill: '1417001079425728512',
  superGrill: '1417001517860388954',
  naughty: '1493348702553772245',
  jail: '1436850178408714250',
  admins: '1146554769222148157',
  seniorMaleMods: '1419143422777757809',
  seniorFemaleMods: '1233044256726192259',
  maleMods: '1148713479788826726',
  femaleMods: '1445326813953003541',
  staff: '1459982542114394194',
  maleHelpers: '1432567445050101863',
  femaleHelpers: '1500148146167091351',
};

const CHANNEL_IDS = {
  grillAnnounce: '1515571833032802344',
  superGrillAnnounce: '1515571855266811934',
  jailAnnounce: '1515571877190566008',
  naughtyAnnounce: '1493348599843782798',
  maleLog: '1504223167433146388',
  femaleLog: '1504223092954890441',
};

const BASE_ROLE_IDS = [
  ROLE_IDS.member,
  ROLE_IDS.male,
  ROLE_IDS.female,
  ROLE_IDS.femaleNonMuslim,
];

const PUNISHMENTS = {
  grill: {
    label: 'Grill',
    roleId: ROLE_IDS.grill,
    announceChannelId: CHANNEL_IDS.grillAnnounce,
  },
  sgrill: {
    label: 'Super Grill',
    roleId: ROLE_IDS.superGrill,
    announceChannelId: CHANNEL_IDS.superGrillAnnounce,
  },
  jail: {
    label: 'Jail',
    roleId: ROLE_IDS.jail,
    announceChannelId: CHANNEL_IDS.jailAnnounce,
  },
  naughty: {
    label: 'Naughty',
    roleId: ROLE_IDS.naughty,
    announceChannelId: CHANNEL_IDS.naughtyAnnounce,
  },
};

const PUNISH_MESSAGES = {
  grill: (user) => `🔥 **${user} has been sent to the GRILL** 🔥\nيلا ع الشواية`,
  sgrill: (user) =>
    `🔥🔥 **${user} has been sent to the SUPER GRILL** 🔥🔥\nيلا ع الشواية البرو ماكس`,
  jail: (user) => `🚔 **${user} has been JAILED** 🚔\nيلا ع السجن`,
  naughty: (user) =>
    `😡 **${user} has been sent to the NAUGHTY CORNER** 😡\nيلا ع النوتي كورنر`,
  deepfry: (user) => `🍳🔥 **${user} has been DEEP FRIED** 🔥🍳\nيلا ع القلاية`,
};

const UNDO_MESSAGES = {
  ungrill: (user) => `🥩❌ **${user} wasn't tasty... removed from the grill**\nمطلعش طعمه حلو`,
  unsgrill: (user) =>
    `🔥❌ **${user} survived the SUPER GRILL... barely**\nواضح إنه مش مستوي لسه`,
  unjail: (user) => `🕊️ **${user} is now FREE**\nتم الافراج عن المتهم`,
  unnaughty: (user) => `😇 **${user} is now a GOODIEE**\nدلوقتي بقت شطورة`,
  undeepfry: (user) =>
    `💀➡️😳 **${user} has been UN-FRIED... bro respawned?!**\nرجع من القلاية بمعجزة 💀🔥`,
};

const AUTH_LEVELS = [
  { level: 50, roleIds: [ROLE_IDS.admins] },
  { level: 40, roleIds: [ROLE_IDS.seniorMaleMods, ROLE_IDS.seniorFemaleMods] },
  { level: 30, roleIds: [ROLE_IDS.maleMods, ROLE_IDS.femaleMods] },
  { level: 20, roleIds: [ROLE_IDS.maleHelpers, ROLE_IDS.femaleHelpers] },
];

const COMMAND_ALIASES = {
  شوي: 'grill',
  شوي_اوي: 'sgrill',
  سجن: 'jail',
  نوتي: 'naughty',
  قلي: 'deepfry',
  تتبيل: 'marinate',
  فك_شوي: 'ungrill',
  فك_شوي_اوي: 'unsgrill',
  فك_سجن: 'unjail',
  فك_نوتي: 'unnaughty',
  فك_قلي: 'undeepfry',
  فك_تتبيل: 'unmarinate',
  مسح: 'purge',
  مسح_الكل: 'allpurge',
  مساعدة: 'help',
};

function hasAdminPermission(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function formatPoints(total) {
  return `${total} ${POINT_SYMBOL}`;
}

function getReason(interaction) {
  return interaction.options.getString('reason') ?? 'No reason provided';
}

function getActorLevel(member) {
  for (const entry of AUTH_LEVELS) {
    if (entry.roleIds.some((roleId) => member.roles.cache.has(roleId))) {
      return entry.level;
    }
  }

  return 0;
}

function hasStaffCommandPermission(member) {
  return getActorLevel(member) >= STAFF_COMMAND_MIN_LEVEL;
}

function getPunishmentAnnounceChannelId(commandName) {
  if (commandName === 'deepfry') {
    return CHANNEL_IDS.grillAnnounce;
  }

  return PUNISHMENTS[commandName]?.announceChannelId ?? null;
}

function getModerationLogChannelId(member) {
  if (member.roles.cache.has(ROLE_IDS.female) || member.roles.cache.has(ROLE_IDS.femaleNonMuslim)) {
    return CHANNEL_IDS.femaleLog;
  }

  return CHANNEL_IDS.maleLog;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getCommandName(interaction) {
  return COMMAND_ALIASES[interaction.commandName] ?? interaction.commandName;
}

function getDurationMs(amount, unit) {
  const multipliers = {
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
}

function formatDuration(amount, unit) {
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  return `${amount} ${amount === 1 ? singular : unit}`;
}

async function fetchMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

async function removeBaseRoles(member) {
  const removedRoleIds = BASE_ROLE_IDS.filter((roleId) => member.roles.cache.has(roleId));

  if (removedRoleIds.length) {
    await member.roles.remove(removedRoleIds);
  }

  return removedRoleIds;
}

async function addRoles(member, roleIds) {
  const uniqueIds = unique(roleIds);

  if (uniqueIds.length) {
    await member.roles.add(uniqueIds);
  }
}

async function removeRoles(member, roleIds) {
  const uniqueIds = unique(roleIds);

  if (uniqueIds.length) {
    await member.roles.remove(uniqueIds);
  }
}

async function sendChannelMessage(guild, channelId, content) {
  if (!channelId) {
    return;
  }

  const channel = await guild.channels.fetch(channelId).catch(() => null);

  if (channel?.isTextBased()) {
    await channel.send({ content });
  }
}

async function sendVisibleMessages(interaction, content, extraChannelId) {
  await interaction.editReply({ content });

  if (extraChannelId && extraChannelId !== interaction.channelId) {
    await sendChannelMessage(interaction.guild, extraChannelId, content);
  }
}

function canActOnTarget(actorMember, targetMember, targetUserId) {
  if (!hasStaffCommandPermission(actorMember)) {
    return false;
  }

  if (actorMember.id === targetUserId) {
    return false;
  }

  if (targetMember?.roles.cache.has(ROLE_IDS.staff)) {
    return false;
  }

  if (!targetMember) {
    return true;
  }

  return getActorLevel(actorMember) > getActorLevel(targetMember);
}

function canBotManageMessages(channel, botMember) {
  if (!botMember) {
    return false;
  }

  const permissions = channel.permissionsFor(botMember);

  return Boolean(
    permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
    ])
  );
}

async function requireStaff(interaction, deferred = false) {
  const actorMember = await fetchMember(interaction.guild, interaction.user.id);

  if (!actorMember || !hasStaffCommandPermission(actorMember)) {
    const message = { content: 'Only mods, senior mods, and admins can use this command.' };

    if (deferred) {
      await interaction.editReply(message);
    } else {
      await interaction.reply({ ...message, ephemeral: true });
    }

    return null;
  }

  return actorMember;
}

async function applyPunishment(interaction, punishmentKey) {
  await interaction.deferReply({ ephemeral: false });

  const punishment = PUNISHMENTS[punishmentKey];
  const targetUser = interaction.options.getUser('user', true);
  const reason = getReason(interaction);
  const actorMember = await requireStaff(interaction, true);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    return;
  }

  if (!canActOnTarget(actorMember, targetMember, targetUser.id)) {
    await interaction.editReply({
      content: 'You cannot use that punishment on this user.',
    });
    return;
  }

  const activePunishment = await getActivePunishment(targetUser.id);
  const removedRoleIdsThisAction = targetMember ? await removeBaseRoles(targetMember) : [];
  const savedRoleIds = activePunishment?.savedRoleIds ?? removedRoleIdsThisAction;

  if (activePunishment?.roleId && targetMember) {
    await removeRoles(targetMember, [activePunishment.roleId]);
  }

  if (targetMember) {
    await addRoles(targetMember, [punishment.roleId]);
  }

  await setActivePunishment(targetUser.id, {
    type: punishmentKey,
    roleId: punishment.roleId,
    savedRoleIds: unique(savedRoleIds),
    moderatorId: interaction.user.id,
    reason,
    updatedAt: new Date().toISOString(),
  });

  await sendVisibleMessages(
    interaction,
    PUNISH_MESSAGES[punishmentKey](targetUser),
    punishment.announceChannelId
  );
}

async function undoPunishment(interaction, punishmentKey) {
  await interaction.deferReply({ ephemeral: false });

  const punishment = PUNISHMENTS[punishmentKey];
  const targetUser = interaction.options.getUser('user', true);
  const actorMember = await requireStaff(interaction, true);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    return;
  }

  if (!canActOnTarget(actorMember, targetMember, targetUser.id)) {
    await interaction.editReply({
      content: 'You cannot undo that punishment for this user.',
    });
    return;
  }

  const activePunishment = await getActivePunishment(targetUser.id);

  if (!activePunishment || activePunishment.type !== punishmentKey) {
    await interaction.editReply({
      content: `${targetUser} does not currently have ${punishment.label}.`,
    });
    return;
  }

  if (targetMember) {
    await removeRoles(targetMember, [punishment.roleId]);
    await addRoles(targetMember, activePunishment.savedRoleIds ?? []);
  }

  await clearActivePunishment(targetUser.id);

  await sendVisibleMessages(
    interaction,
    UNDO_MESSAGES[`un${punishmentKey}`](targetUser),
    getPunishmentAnnounceChannelId(punishmentKey)
  );
}

async function handleDeepfry(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser('user', true);
  const reason = getReason(interaction);
  const actorMember = await requireStaff(interaction, true);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    return;
  }

  if (!canActOnTarget(actorMember, targetMember, targetUser.id)) {
    await interaction.editReply({
      content: 'You cannot use that punishment on this user.',
    });
    return;
  }

  const activePunishment = await getActivePunishment(targetUser.id);

  if (activePunishment?.roleId && targetMember) {
    await removeRoles(targetMember, [activePunishment.roleId]);
  }

  await setActivePunishment(targetUser.id, {
    type: 'deepfry',
    moderatorId: interaction.user.id,
    reason,
    updatedAt: new Date().toISOString(),
  });

  const alreadyBanned = await interaction.guild.bans.fetch(targetUser.id).then(
    () => true,
    () => false
  );

  if (!alreadyBanned) {
    await interaction.guild.bans.create(targetUser.id, { reason });
  }

  await sendVisibleMessages(
    interaction,
    PUNISH_MESSAGES.deepfry(targetUser),
    getPunishmentAnnounceChannelId('deepfry')
  );
}

async function handleUndeepfry(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser('user', true);
  const actorMember = await requireStaff(interaction, true);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    return;
  }

  if (!canActOnTarget(actorMember, targetMember, targetUser.id)) {
    await interaction.editReply({
      content: 'You cannot undo that punishment for this user.',
    });
    return;
  }

  const activePunishment = await getActivePunishment(targetUser.id);

  if (!activePunishment || activePunishment.type !== 'deepfry') {
    await interaction.editReply({
      content: `${targetUser} does not currently have ${DEEPFRY_LABEL}.`,
    });
    return;
  }

  await interaction.guild.bans.remove(targetUser.id).catch(() => null);
  await clearActivePunishment(targetUser.id);

  await sendVisibleMessages(interaction, UNDO_MESSAGES.undeepfry(targetUser), null);
}

async function handleMarinate(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser('user', true);
  const duration = interaction.options.getInteger('duration', true);
  const unit = interaction.options.getString('unit', true);
  const durationMs = getDurationMs(duration, unit);
  const durationText = formatDuration(duration, unit);
  const reason = getReason(interaction);
  const actorMember = await requireStaff(interaction, true);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    return;
  }

  if (!targetMember) {
    await interaction.editReply({
      content: 'I could not find that member in this server.',
    });
    return;
  }

  if (durationMs > MAX_TIMEOUT_MS) {
    await interaction.editReply({
      content: 'Discord timeouts cannot be longer than 28 days.',
    });
    return;
  }

  if (!canActOnTarget(actorMember, targetMember, targetUser.id)) {
    await interaction.editReply({
      content: 'You cannot marinate this user.',
    });
    return;
  }

  await targetMember.timeout(durationMs, reason);

  const logMessage = `**Timeout Log**\n${interaction.user} timed out ${targetUser} for ${durationText}.\nReason: ${reason}`;

  await sendVisibleMessages(
    interaction,
    logMessage,
    getModerationLogChannelId(targetMember)
  );
}

async function handleUnmarinate(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser('user', true);
  const actorMember = await requireStaff(interaction, true);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    return;
  }

  if (!targetMember) {
    await interaction.editReply({
      content: 'I could not find that member in this server.',
    });
    return;
  }

  if (!canActOnTarget(actorMember, targetMember, targetUser.id)) {
    await interaction.editReply({
      content: 'You cannot unmarinate this user.',
    });
    return;
  }

  await targetMember.timeout(null, `Timeout removed by ${interaction.user.tag}`);

  const logMessage = `**Timeout Log**\n${interaction.user} removed ${targetUser}'s timeout.`;

  await sendVisibleMessages(
    interaction,
    logMessage,
    getModerationLogChannelId(targetMember)
  );
}

async function handleAdd(interaction) {
  if (!hasAdminPermission(interaction)) {
    await interaction.reply({
      content: `Only admins can add ${POINT_SYMBOL}.`,
      ephemeral: true,
    });
    return;
  }

  const user = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('points', true);
  const total = await addUserPoints(user.id, amount);

  await interaction.reply(
    `Added ${formatPoints(amount)} to ${user}. They now have ${formatPoints(total)}.`
  );
}

async function handleRemove(interaction) {
  if (!hasAdminPermission(interaction)) {
    await interaction.reply({
      content: `Only admins can remove ${POINT_SYMBOL}.`,
      ephemeral: true,
    });
    return;
  }

  const user = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('points', true);
  const total = await removeUserPoints(user.id, amount);

  await interaction.reply(
    `Removed ${formatPoints(amount)} from ${user}. They now have ${formatPoints(total)}.`
  );
}

async function handleLeaderboard(interaction) {
  const leaderboard = await getLeaderboard();

  if (leaderboard.length === 0) {
    await interaction.reply(`No ${LEADERBOARD_TITLE} has been awarded yet.`);
    return;
  }

  const lines = leaderboard.map(
    (entry, index) => `${index + 1}. <@${entry.userId}> - ${formatPoints(entry.total)}`
  );

  await interaction.reply(`**${LEADERBOARD_TITLE}**\n${lines.join('\n')}`);
}

async function handleTrade(interaction) {
  const receiver = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('points', true);
  const sender = interaction.user;

  if (receiver.bot) {
    await interaction.reply({
      content: `You cannot trade ${POINT_SYMBOL} to bots.`,
      ephemeral: true,
    });
    return;
  }

  if (receiver.id === sender.id) {
    await interaction.reply({
      content: `You cannot trade ${POINT_SYMBOL} to yourself.`,
      ephemeral: true,
    });
    return;
  }

  const result = await transferPoints(sender.id, receiver.id, amount);

  if (!result.ok) {
    const currentPoints = await getUserPoints(sender.id);
    await interaction.reply({
      content: `You only have ${formatPoints(currentPoints)}.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.reply(
    `${sender} traded ${formatPoints(amount)} to ${receiver}. ${sender} now has ${formatPoints(
      result.senderPoints
    )}.`
  );
}

async function deleteMessagesInChannel(channel, count, targetUserId, botMember) {
  if (!channel?.messages?.fetch || !canBotManageMessages(channel, botMember)) {
    return 0;
  }

  let deletedCount = 0;
  let before;
  let scanned = 0;

  while (deletedCount < count && scanned < 5000) {
    const fetched = await channel.messages.fetch({ limit: 100, before }).catch(() => null);

    if (!fetched?.size) {
      break;
    }

    scanned += fetched.size;
    before = fetched.last().id;

    const candidates = [...fetched.values()]
      .filter((message) => !targetUserId || message.author?.id === targetUserId)
      .filter((message) => Date.now() - message.createdTimestamp < BULK_DELETE_MAX_AGE_MS)
      .slice(0, count - deletedCount);

    if (!candidates.length) {
      continue;
    }

    const deleted = await channel.bulkDelete(candidates, true).catch(() => null);
    deletedCount += deleted?.size ?? 0;
  }

  return deletedCount;
}

async function handlePurge(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const actorMember = await requireStaff(interaction, true);
  if (!actorMember) {
    return;
  }

  const count = interaction.options.getInteger('count', true);
  const targetUser = interaction.options.getUser('user', false);
  const targetMember = targetUser ? await fetchMember(interaction.guild, targetUser.id) : null;

  if (targetUser && !canActOnTarget(actorMember, targetMember, targetUser.id)) {
    await interaction.editReply({
      content: 'You cannot purge messages from this user.',
    });
    return;
  }

  const botMember = await fetchMember(interaction.guild, client.user.id);
  const deletedCount = await deleteMessagesInChannel(
    interaction.channel,
    count,
    targetUser?.id,
    botMember
  );

  await interaction.editReply({
    content: `Deleted ${deletedCount} message(s)${
      targetUser ? ` from ${targetUser}` : ''
    }. Messages older than 14 days are skipped by Discord bulk delete.`,
  });
}

async function handleAllPurge(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const actorMember = await requireStaff(interaction, true);
  if (!actorMember) {
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const count = interaction.options.getInteger('count', true);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!canActOnTarget(actorMember, targetMember, targetUser.id)) {
    await interaction.editReply({
      content: 'You cannot purge messages from this user.',
    });
    return;
  }

  const botMember = await fetchMember(interaction.guild, client.user.id);
  const channels = await interaction.guild.channels.fetch();
  let deletedCount = 0;

  for (const channel of channels.values()) {
    if (deletedCount >= count) {
      break;
    }

    if (!channel?.isTextBased?.() || !channel.messages?.fetch) {
      continue;
    }

    deletedCount += await deleteMessagesInChannel(
      channel,
      count - deletedCount,
      targetUser.id,
      botMember
    );
  }

  await interaction.editReply({
    content: `Deleted ${deletedCount} message(s) from ${targetUser} across available channels. Messages older than 14 days are skipped by Discord bulk delete.`,
  });
}

async function handleHelp(interaction) {
  await interaction.reply({
    ephemeral: true,
    content: [
      '**Sunnah Shield Bot Commands**',
      '`/grill user reason` or `/شوي` - remove base roles and apply Grill.',
      '`/sgrill user reason` or `/شوي_اوي` - switch/apply Super Grill.',
      '`/jail user reason` or `/سجن` - remove base roles and apply Jail.',
      '`/naughty user reason` or `/نوتي` - remove base roles and apply Naughty.',
      '`/deepfry user reason` or `/قلي` - ban a user.',
      '`/marinate user duration unit reason` or `/تتبيل` - timeout a user.',
      '`/ungrill`, `/unsgrill`, `/unjail`, `/unnaughty`, `/undeepfry`, `/unmarinate` - undo the matching action.',
      '`/purge count user?` or `/مسح` - delete recent messages in this channel.',
      '`/allpurge user count` or `/مسح_الكل` - delete a user’s recent messages across channels.',
      'Punishment and purge commands are mod/senior/admin only. Helpers are excluded.',
    ].join('\n'),
  });
}

async function handleJoinGuard(member) {
  const activePunishment = await getActivePunishment(member.id);

  if (!activePunishment) {
    return;
  }

  if (activePunishment.type === 'deepfry') {
    await member.guild.bans
      .create(member.id, {
        reason: 'Active deepfry record rejoin guard',
      })
      .catch(() => null);
    return;
  }

  await removeBaseRoles(member);
  await addRoles(member, [activePunishment.roleId]);

  let attempts = 6;

  const tick = async () => {
    attempts -= 1;

    const latestPunishment = await getActivePunishment(member.id);
    if (!latestPunishment) {
      return;
    }

    const freshMember = await fetchMember(member.guild, member.id);
    if (!freshMember) {
      return;
    }

    await removeBaseRoles(freshMember);
    await addRoles(freshMember, [latestPunishment.roleId]);

    if (attempts > 0) {
      setTimeout(tick, 10_000);
    }
  };

  if (attempts > 0) {
    setTimeout(tick, 10_000);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await handleJoinGuard(member);
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const commandName = getCommandName(interaction);

  try {
    if (commandName === 'add') {
      await handleAdd(interaction);
      return;
    }

    if (commandName === 'remove') {
      await handleRemove(interaction);
      return;
    }

    if (commandName === 'leaderboard') {
      await handleLeaderboard(interaction);
      return;
    }

    if (commandName === 'trade') {
      await handleTrade(interaction);
      return;
    }

    if (commandName === 'grill') {
      await applyPunishment(interaction, 'grill');
      return;
    }

    if (commandName === 'sgrill') {
      await applyPunishment(interaction, 'sgrill');
      return;
    }

    if (commandName === 'jail') {
      await applyPunishment(interaction, 'jail');
      return;
    }

    if (commandName === 'naughty') {
      await applyPunishment(interaction, 'naughty');
      return;
    }

    if (commandName === 'deepfry') {
      await handleDeepfry(interaction);
      return;
    }

    if (commandName === 'marinate') {
      await handleMarinate(interaction);
      return;
    }

    if (commandName === 'ungrill') {
      await undoPunishment(interaction, 'grill');
      return;
    }

    if (commandName === 'unsgrill') {
      await undoPunishment(interaction, 'sgrill');
      return;
    }

    if (commandName === 'unjail') {
      await undoPunishment(interaction, 'jail');
      return;
    }

    if (commandName === 'unnaughty') {
      await undoPunishment(interaction, 'naughty');
      return;
    }

    if (commandName === 'undeepfry') {
      await handleUndeepfry(interaction);
      return;
    }

    if (commandName === 'unmarinate') {
      await handleUnmarinate(interaction);
      return;
    }

    if (commandName === 'purge') {
      await handlePurge(interaction);
      return;
    }

    if (commandName === 'allpurge') {
      await handleAllPurge(interaction);
      return;
    }

    if (commandName === 'help') {
      await handleHelp(interaction);
    }
  } catch (error) {
    console.error(error);

    const message = {
      content: 'Something went wrong while handling that command.',
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(message);
    } else {
      await interaction.reply(message);
    }
  }
});

async function start() {
  await deployCommands();
  await client.login(DISCORD_TOKEN);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
