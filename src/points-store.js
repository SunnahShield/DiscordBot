const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const POINTS_FILE = path.join(DATA_DIR, 'points.json');

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(POINTS_FILE);
  } catch {
    await fs.writeFile(POINTS_FILE, JSON.stringify({ users: {} }, null, 2));
  }
}

async function readPoints() {
  await ensureStore();
  const content = await fs.readFile(POINTS_FILE, 'utf8');
  return JSON.parse(content);
}

async function writePoints(points) {
  await ensureStore();
  await fs.writeFile(POINTS_FILE, JSON.stringify(points, null, 2));
}

async function getUserPoints(userId) {
  const points = await readPoints();
  return points.users[userId] ?? 0;
}

async function addUserPoints(userId, amount) {
  const points = await readPoints();
  points.users[userId] = (points.users[userId] ?? 0) + amount;
  await writePoints(points);
  return points.users[userId];
}

async function removeUserPoints(userId, amount) {
  const points = await readPoints();
  points.users[userId] = Math.max(0, (points.users[userId] ?? 0) - amount);
  await writePoints(points);
  return points.users[userId];
}

async function transferPoints(fromUserId, toUserId, amount) {
  const points = await readPoints();
  const senderPoints = points.users[fromUserId] ?? 0;

  if (senderPoints < amount) {
    return {
      ok: false,
      senderPoints,
    };
  }

  points.users[fromUserId] = senderPoints - amount;
  points.users[toUserId] = (points.users[toUserId] ?? 0) + amount;
  await writePoints(points);

  return {
    ok: true,
    senderPoints: points.users[fromUserId],
    receiverPoints: points.users[toUserId],
  };
}

async function getLeaderboard(limit = 10) {
  const points = await readPoints();
  return Object.entries(points.users)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([userId, total]) => ({ userId, total }));
}

module.exports = {
  addUserPoints,
  getLeaderboard,
  getUserPoints,
  removeUserPoints,
  transferPoints,
};
