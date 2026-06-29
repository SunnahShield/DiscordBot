require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { commands } = require('./commands');

const { CLIENT_ID, DISCORD_TOKEN, GUILD_ID } = process.env;

if (!CLIENT_ID || !DISCORD_TOKEN) {
  throw new Error('CLIENT_ID and DISCORD_TOKEN must be set in .env');
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function deployCommands() {
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);

  await rest.put(route, {
    body: commands.map((command) => command.toJSON()),
  });

  console.log(
    GUILD_ID ? 'Slash commands registered for the guild.' : 'Global slash commands registered.'
  );
}

module.exports = {
  deployCommands,
};

if (require.main === module) {
  deployCommands().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
