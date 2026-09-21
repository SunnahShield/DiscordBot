const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'member-messages.json');

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(CONFIG_FILE);
  } catch {
    await fs.writeFile(CONFIG_FILE, JSON.stringify({ guilds: {} }, null, 2));
  }
}

async function readConfig() {
  await ensureStore();
  return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
}

async function saveConfig(config) {
  await ensureStore();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function getMemberMessageConfig(guildId, type) {
  const config = await readConfig();
  return config.guilds[guildId]?.[type] ?? null;
}

async function setMemberMessageConfig(guildId, type, value) {
  const config = await readConfig();
  config.guilds[guildId] ??= {};
  config.guilds[guildId][type] = value;
  await saveConfig(config);
}

module.exports = {
  getMemberMessageConfig,
  setMemberMessageConfig,
};
