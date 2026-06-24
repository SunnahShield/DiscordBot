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

function getPunishmentAnnounceChannelId(commandName) {
  return PUNISHMENTS[commandName]?.announceChannelId ?? null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function formatRoleList(roleIds, guild) {
  if (!roleIds.length) {
    return 'none';
  }

  return roleIds
    .map((roleId) => guild.roles.cache.get(roleId)?.name ?? `<@&${roleId}>`)
    .join(', ');
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

async function sendPunishmentMessages(interaction, content, extraChannelMessages) {
  await interaction.editReply({ content });

  const sentChannelIds = new Set([interaction.channelId]);

  for (const { channelId, message } of extraChannelMessages) {
    if (!channelId || sentChannelIds.has(channelId)) {
      continue;
    }

    sentChannelIds.add(channelId);
    await sendChannelMessage(interaction.guild, channelId, message);
  }
}

function hasPermissionToAct(member) {
  return getActorLevel(member) > 0;
}

function canActOnTarget(actorMember, targetMember, targetUserId) {
  if (!hasPermissionToAct(actorMember)) {
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

async function applyPunishment(interaction, punishmentKey) {
  await interaction.deferReply({ ephemeral: false });

  const punishment = PUNISHMENTS[punishmentKey];
  const targetUser = interaction.options.getUser('user', true);
  const reason = getReason(interaction);
  const actorMember = await fetchMember(interaction.guild, interaction.user.id);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    await interaction.editReply({
      content: 'I could not read your server member record.',
    });
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

  const publicMessage = PUNISH_MESSAGES[punishmentKey](targetUser);

  await sendPunishmentMessages(interaction, publicMessage, [
    {
      channelId: punishment.announceChannelId,
      message: publicMessage,
    },
  ]);
}

async function undoPunishment(interaction, punishmentKey) {
  await interaction.deferReply({ ephemeral: false });

  const punishment = PUNISHMENTS[punishmentKey];
  const targetUser = interaction.options.getUser('user', true);
  const actorMember = await fetchMember(interaction.guild, interaction.user.id);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    await interaction.editReply({
      content: 'I could not read your server member record.',
    });
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

  const publicMessage = UNDO_MESSAGES[`un${punishmentKey}`](targetUser);

  await interaction.editReply({
    content: publicMessage,
  });

  await sendChannelMessage(
    interaction.guild,
    getPunishmentAnnounceChannelId(punishmentKey),
    publicMessage
  );
}

async function handleDeepfry(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser('user', true);
  const reason = getReason(interaction);
  const actorMember = await fetchMember(interaction.guild, interaction.user.id);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    await interaction.editReply({
      content: 'I could not read your server member record.',
    });
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

  await interaction.editReply({
    content: `${DEEPFRY_LABEL} applied to ${targetUser}. Reason: ${reason}.`,
  });
}

async function handleUndeepfry(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser('user', true);
  const actorMember = await fetchMember(interaction.guild, interaction.user.id);
  const targetMember = await fetchMember(interaction.guild, targetUser.id);

  if (!actorMember) {
    await interaction.editReply({
      content: 'I could not read your server member record.',
    });
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

  const publicMessage = UNDO_MESSAGES.undeepfry(targetUser);

  await interaction.editReply({
    content: publicMessage,
  });
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

async function handleJoinGuard(member) {
  const activePunishment = await getActivePunishment(member.id);

  if (!activePunishment) {
    return;
  }

  if (activePunishment.type === 'deepfry') {
    await member.guild.bans.create(member.id, {
      reason: 'Active deepfry record rejoin guard',
    }).catch(() => null);
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

  try {
    if (interaction.commandName === 'add') {
      await handleAdd(interaction);
      return;
    }

    if (interaction.commandName === 'remove') {
      await handleRemove(interaction);
      return;
    }

    if (interaction.commandName === 'leaderboard') {
      await handleLeaderboard(interaction);
      return;
    }

    if (interaction.commandName === 'trade') {
      await handleTrade(interaction);
      return;
    }

    if (interaction.commandName === 'grill') {
      await applyPunishment(interaction, 'grill');
      return;
    }

    if (interaction.commandName === 'sgrill') {
      await applyPunishment(interaction, 'sgrill');
      return;
    }

    if (interaction.commandName === 'jail') {
      await applyPunishment(interaction, 'jail');
      return;
    }

    if (interaction.commandName === 'naughty') {
      await applyPunishment(interaction, 'naughty');
      return;
    }

    if (interaction.commandName === 'deepfry') {
      await handleDeepfry(interaction);
      return;
    }

    if (interaction.commandName === 'ungrill') {
      await undoPunishment(interaction, 'grill');
      return;
    }

    if (interaction.commandName === 'unsgrill') {
      await undoPunishment(interaction, 'sgrill');
      return;
    }

    if (interaction.commandName === 'unjail') {
      await undoPunishment(interaction, 'jail');
      return;
    }

    if (interaction.commandName === 'unnaughty') {
      await undoPunishment(interaction, 'naughty');
      return;
    }

    if (interaction.commandName === 'undeepfry') {
      await handleUndeepfry(interaction);
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
