const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'invite-tracker.json');

// All mutations are serialized in-process.  Invite joins and leaves can arrive
// back-to-back, so a read/modify/write cycle must not overwrite another one.
let operation = Promise.resolve();

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STORE_FILE);
  } catch {
    await fs.writeFile(STORE_FILE, JSON.stringify({ version: 1, guilds: {} }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      parsed.version ??= 1;
      parsed.guilds ??= {};
      return parsed;
    }
  } catch {
    // A corrupt state file should not make moderation logging fail. The next
    // write starts a clean, valid state file.
  }
  return { version: 1, guilds: {} };
}

async function writeStore(store) {
  await ensureStore();
  const temporaryFile = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(store, null, 2));
  await fs.rename(temporaryFile, STORE_FILE);
}

function queue(task) {
  const next = operation.then(task, task);
  operation = next.catch(() => null);
  return next;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeGuildState(value) {
  const state = value && typeof value === 'object' ? value : {};
  state.attributions ??= {};
  return state;
}

async function getInviteTrackerState(guildId) {
  return queue(async () => {
    const store = await readStore();
    return clone(normalizeGuildState(store.guilds[guildId]));
  });
}

async function updateInviteTrackerState(guildId, updater) {
  return queue(async () => {
    const store = await readStore();
    const state = normalizeGuildState(store.guilds[guildId]);
    const result = await updater(state);
    store.guilds[guildId] = state;
    await writeStore(store);
    return clone(result);
  });
}

module.exports = {
  getInviteTrackerState,
  updateInviteTrackerState,
};
