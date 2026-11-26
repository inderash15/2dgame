require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Game, Team, Mentor, Allocation, AdminUser } = require('./models');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function normalizeMentorUsername(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.]/g, '').replace(/\.+/g, '.');
}

async function seed() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in server/.env');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB Atlas');

  const pubPath = path.resolve(__dirname, '..', 'published-data.json');
  const pub = JSON.parse(fs.readFileSync(pubPath, 'utf8'));

  // 1. Upsert 1,750 Games
  const gameOps = pub.games.map(g => ({
    updateOne: { filter: { gameId: g.gameId }, update: { $set: g }, upsert: true }
  }));
  await Game.bulkWrite(gameOps);

  // 2. Upsert 263 Teams
  const teamOps = pub.teams.map(t => ({
    updateOne: {
      filter: { teamId: t.teamId },
      update: { $set: { ...t, teamId: t.teamId } },
      upsert: true
    }
  }));
  await Team.bulkWrite(teamOps);

  // 3. Sync 21 Faculty Mentors (initial password: pass123, mustChangePassword: true)
  const uniqueMentors = new Map();
  for (const t of pub.teams) {
    if (!t.facultyMentor) continue;
    const username = normalizeMentorUsername(t.facultyMentor);
    if (!uniqueMentors.has(username)) uniqueMentors.set(username, { displayName: t.facultyMentor, department: t.department || '' });
  }
  for (const [username, info] of uniqueMentors.entries()) {
    const exists = await Mentor.findOne({ username });
    if (!exists) {
      const { salt, hash } = hashPassword('pass123');
      await Mentor.create({ username, displayName: info.displayName, department: info.department, passwordHash: hash, salt, mustChangePassword: true, active: true });
    }
  }

  // 4. Upsert Published Allocation (v1)
  const existingAlloc = await Allocation.findOne({ version: pub.version || 'v1' });
  if (!existingAlloc) {
    await Allocation.create({
      version: pub.version || 'v1',
      seed: pub.seed || 'SOISDS-2026-SEED-01',
      status: 'Published',
      assignments: pub.publishedAllocations.map(a => ({ gameId: a.gameId, teamId: a.teamId || a.teamNumber })),
      teamMeta: pub.teamMeta,
      sixGameTeams: pub.sixGameTeams,
      createdBy: 'seed'
    });
  }

  // 5. Ensure default superadmin exists if admins collection is empty
  if ((await AdminUser.countDocuments()) === 0) {
    const initialPass = process.env.ADMIN_INIT_PASSWORD || 'admin123';
    const { salt, hash } = hashPassword(initialPass);
    await AdminUser.create({ username: 'admin', passwordHash: hash, salt, role: 'superadmin' });
    console.log('Created initial superadmin (username: admin)');
  }

  const counts = await Promise.all([
    Game.countDocuments(), Team.countDocuments(), Mentor.countDocuments(),
    Allocation.countDocuments(), AdminUser.countDocuments()
  ]);
  console.log('Seeded MongoDB Atlas:', { games: counts[0], teams: counts[1], mentors: counts[2], allocations: counts[3], admins: counts[4] });
  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
