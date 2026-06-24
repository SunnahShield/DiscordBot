const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

const pointOption = (builder) =>
  builder
    .setName('points')
    .setDescription('Number of SSP')
    .setRequired(true)
    .setMinValue(1);

const userOption = (builder) =>
  builder
    .setName('user')
    .setDescription('Discord user')
    .setRequired(true);

const reasonOption = (builder) =>
  builder
    .setName('reason')
    .setDescription('Reason for this action')
    .setRequired(false);

const punishCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addUserOption(userOption)
    .addStringOption(reasonOption);

const undoCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addUserOption(userOption);

const commands = [
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add SSP to a user')
    .addUserOption(userOption)
    .addIntegerOption(pointOption)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove SSP from a user')
    .addUserOption(userOption)
    .addIntegerOption(pointOption)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the Sunnah Shield Points leaderboard'),

  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Give your SSP to another user')
    .addUserOption(userOption)
    .addIntegerOption(pointOption),

  punishCommand('grill', 'Apply Grill to a user'),
  punishCommand('sgrill', 'Apply Super Grill to a user'),
  punishCommand('jail', 'Apply Jail to a user'),
  punishCommand('naughty', 'Apply Naughty to a user'),
  punishCommand('deepfry', 'Ban a user'),
  undoCommand('ungrill', 'Remove Grill from a user'),
  undoCommand('unsgrill', 'Remove Super Grill from a user'),
  undoCommand('unjail', 'Remove Jail from a user'),
  undoCommand('unnaughty', 'Remove Naughty from a user'),
  undoCommand('undeepfry', 'Unban a user'),
];

module.exports = {
  commands,
};
