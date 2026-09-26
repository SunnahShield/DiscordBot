const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'automations.json');

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(CONFIG_FILE);
  } catch {
    await fs.writeFile(CONFIG_FILE, JSON.stringify({ guilds: {} }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
}

async function saveStore(store) {
  await ensureStore();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(store, null, 2));
}

async function getAutomationConfig(guildId, type) {
  const store = await readStore();
  return store.guilds[guildId]?.[type] ?? null;
}

async function setAutomationConfig(guildId, type, value) {
  const store = await readStore();
  store.guilds[guildId] ??= {};
  store.guilds[guildId][type] = value;
  await saveStore(store);
}

async function clearAutomationConfig(guildId, type) {
  const store = await readStore();
  if (!store.guilds[guildId]) return;
  delete store.guilds[guildId][type];
  if (Object.keys(store.guilds[guildId]).length === 0) delete store.guilds[guildId];
  await saveStore(store);
}

module.exports = { clearAutomationConfig, getAutomationConfig, setAutomationConfig };
