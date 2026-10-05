const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PUNISHMENTS_FILE = path.join(DATA_DIR, 'punishments.json');

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(PUNISHMENTS_FILE);
  } catch {
    await fs.writeFile(PUNISHMENTS_FILE, JSON.stringify({ guilds: {} }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const content = await fs.readFile(PUNISHMENTS_FILE, 'utf8');
  return JSON.parse(content);
}

async function writeStore(store) {
  await ensureStore();
  await fs.writeFile(PUNISHMENTS_FILE, JSON.stringify(store, null, 2));
}

async function getActivePunishment(guildId, userId) {
  const store = await readStore();
  return store.guilds?.[guildId]?.[userId] ?? null;
}

async function setActivePunishment(guildId, userId, record) {
  const store = await readStore();
  store.guilds ??= {};
  store.guilds[guildId] ??= {};
  store.guilds[guildId][userId] = record;
  await writeStore(store);
  return record;
}

async function clearActivePunishment(guildId, userId) {
  const store = await readStore();
  if (store.guilds?.[guildId]) delete store.guilds[guildId][userId];
  await writeStore(store);
}

async function listActivePunishments(guildId) {
  const store = await readStore();
  return store.guilds?.[guildId] ?? {};
}

module.exports = {
  clearActivePunishment,
  getActivePunishment,
  listActivePunishments,
  setActivePunishment,
};
