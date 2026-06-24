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

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN must be set in .env');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const POINT_NAME = 'Knowledge Point | نقطة معرفة';

function hasAdminPermission(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function formatPoints(total) {
  return `${total} ${POINT_NAME}`;
}

async function handleAdd(interaction) {
  if (!hasAdminPermission(interaction)) {
    await interaction.reply({
      content: `Only admins can add ${POINT_NAME}.`,
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
      content: `Only admins can remove ${POINT_NAME}.`,
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
    await interaction.reply(`No ${POINT_NAME} has been awarded yet.`);
    return;
  }

  const lines = leaderboard.map(
    (entry, index) => `${index + 1}. <@${entry.userId}> - ${formatPoints(entry.total)}`
  );

  await interaction.reply(`**${POINT_NAME} Leaderboard**\n${lines.join('\n')}`);
}

async function handleTrade(interaction) {
  const receiver = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('points', true);
  const sender = interaction.user;

  if (receiver.bot) {
    await interaction.reply({
      content: `You cannot trade ${POINT_NAME} to bots.`,
      ephemeral: true,
    });
    return;
  }

  if (receiver.id === sender.id) {
    await interaction.reply({
      content: `You cannot trade ${POINT_NAME} to yourself.`,
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

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
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
