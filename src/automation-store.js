const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'automations.json');
let storeOperation = Promise.resolve();

// Configuration commands can arrive at virtually the same time (for example
// when two administrators configure different log channels). Serialising the
// read-modify-write cycle prevents one command from silently overwriting the
// other command's setting.
function queueStoreOperation(operation) {
  const next = storeOperation.then(operation, operation);
  storeOperation = next.catch(() => null);
  return next;
}

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
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(store, null, 2));
  await fs.rename(temporaryFile, CONFIG_FILE);
}

async function getAutomationConfig(guildId, type) {
  return queueStoreOperation(async () => {
    const store = await readStore();
    return store.guilds[guildId]?.[type] ?? null;
  });
}

async function setAutomationConfig(guildId, type, value) {
  return queueStoreOperation(async () => {
    const store = await readStore();
    store.guilds[guildId] ??= {};
    store.guilds[guildId][type] = value;
    await saveStore(store);
  });
}

async function clearAutomationConfig(guildId, type) {
  return queueStoreOperation(async () => {
    const store = await readStore();
    if (!store.guilds[guildId]) return;
    delete store.guilds[guildId][type];
    if (Object.keys(store.guilds[guildId]).length === 0) delete store.guilds[guildId];
    await saveStore(store);
  });
}

module.exports = { clearAutomationConfig, getAutomationConfig, setAutomationConfig };
