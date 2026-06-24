const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

const pointOption = (builder) =>
  builder
    .setName('points')
    .setDescription('Number of Knowledge Point | نقطة معرفة')
    .setRequired(true)
    .setMinValue(1);

const userOption = (builder) =>
  builder
    .setName('user')
    .setDescription('Discord user')
    .setRequired(true);

const commands = [
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add Knowledge Point | نقطة معرفة to a user')
    .addUserOption(userOption)
    .addIntegerOption(pointOption)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove Knowledge Point | نقطة معرفة from a user')
    .addUserOption(userOption)
    .addIntegerOption(pointOption)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the Knowledge Point | نقطة معرفة leaderboard'),

  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Give your Knowledge Point | نقطة معرفة to another user')
    .addUserOption(userOption)
    .addIntegerOption(pointOption),
];

module.exports = {
  commands,
};
