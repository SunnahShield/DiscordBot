const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PUNISHMENTS_FILE = path.join(DATA_DIR, 'punishments.json');

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(PUNISHMENTS_FILE);
  } catch {
    await fs.writeFile(PUNISHMENTS_FILE, JSON.stringify({ users: {} }, null, 2));
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

async function getActivePunishment(userId) {
  const store = await readStore();
  return store.users[userId] ?? null;
}

async function setActivePunishment(userId, record) {
  const store = await readStore();
  store.users[userId] = record;
  await writeStore(store);
  return record;
}

async function clearActivePunishment(userId) {
  const store = await readStore();
  delete store.users[userId];
  await writeStore(store);
}

async function listActivePunishments() {
  const store = await readStore();
  return store.users;
}

module.exports = {
  clearActivePunishment,
  getActivePunishment,
  listActivePunishments,
  setActivePunishment,
};
