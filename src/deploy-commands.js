require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { commands } = require('./commands');

const { CLIENT_ID, DISCORD_TOKEN, GUILD_ID } = process.env;

if (!CLIENT_ID || !DISCORD_TOKEN || !GUILD_ID) {
  throw new Error('CLIENT_ID, DISCORD_TOKEN, and GUILD_ID must be set in .env');
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function deployCommands() {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands.map((command) => command.toJSON()),
  });

  console.log('Slash commands registered.');
}

deployCommands().catch((error) => {
  console.error(error);
  process.exit(1);
});
