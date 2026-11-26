require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { Game, Team, Mentor, ProgressUpdate, Allocation, AdminUser, Announcement, AuditLog } = require('./models');

const app = express();
const PORT = process.env.PORT || 4000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 400 }));
app.use(express.static(path.resolve(__dirname, '..')));

function normalizeTeamId(input) {
  const cleaned = String(input || '').trim().toUpperCase().replace(/^TEAM\s*/i, '').replace(/[\s\-_]+/g, '');
  const m = cleaned.match(/^T?0*(\d{1,3})$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 999) return 'T' + String(n).padStart(3, '0');
  }
  return String(input || '').trim().toUpperCase();
}

function normalizeMentorUsername(name) {
  let s = String(name || '').trim()
    .replace(/^(dr|mr|mrs|ms|prof)\.?\s*/i, '')
    .replace(/^k(?=jayanthi)/i, '')
    .replace(/^mp\.?\s*/i, '');
  const parts = s.split(/[\s.]+/).filter(p => p && p.length > 1);
  return (parts.join('') || s.replace(/[^a-z0-9]/gi, '')).toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}
function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  if (parsed.exp && Date.now() > parsed.exp) return null;
  return parsed;
}

function getSessionUser(req) {
  const token = req.cookies?.gh_session || req.headers.authorization?.replace('Bearer ', '');
  return verifyToken(token);
}

function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user || !['admin', 'superadmin'].includes(user.role)) {
    return res.status(401).json({ error: 'Unauthorized: Administrator role required' });
  }
  req.user = user;
  next();
}

function requireMentor(req, res, next) {
  const user = getSessionUser(req);
  if (!user || user.role !== 'faculty_mentor') {
    return res.status(401).json({ error: 'Unauthorized: Faculty Mentor role required' });
  }
  req.user = user;
  next();
}

function validateAllocationIntegrity(assignments, teams, games) {
  const gameIds = new Set(games.filter(g => !g.archived).map(g => g.gameId));
  const teamIds = new Set(teams.map(t => t.teamId));
  const assignedGames = new Set();
  const counts = Object.fromEntries([...teamIds].map(t => [t, 0]));

  for (const a of assignments) {
    const tid = normalizeTeamId(a.teamId);
    if (!gameIds.has(a.gameId)) return { ok: false, error: `Invalid Game ID: ${a.gameId}` };
    if (!teamIds.has(tid)) return { ok: false, error: `Invalid Team ID: ${tid}` };
    if (assignedGames.has(a.gameId)) return { ok: false, error: `Duplicate assignment: ${a.gameId}` };
    assignedGames.add(a.gameId);
    counts[tid]++;
  }
  const vals = Object.values(counts);
  const t7 = vals.filter(c => c === 7).length;
  const t6 = vals.filter(c => c === 6).length;
  if (assignedGames.size !== 1750 || t7 !== 172 || t6 !== 91) {
    return { ok: false, error: `Integrity failed: ${assignedGames.size}/1750 games, ${t7}/172 seven-game teams, ${t6}/91 six-game teams` };
  }
  return { ok: true };
}

async function syncMentorsFromTeams() {
  const teams = await Team.find().select('facultyMentor department').lean();
  const uniqueMentors = new Map();
  for (const t of teams) {
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
}

app.get('/api/health', async (_req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const [teamCount, gameCount, mentorCount] = dbReady
    ? await Promise.all([Team.countDocuments(), Game.countDocuments(), Mentor.countDocuments()])
    : [0, 0, 0];
  res.json({ ok: true, dbConnected: dbReady, teamCount, gameCount, mentorCount });
});

// ============================================================================
// ADMIN AUTH & MANAGEMENT ROUTES
// ============================================================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const admin = await AdminUser.findOne({ username });
  if (!admin || !verifyPassword(password, admin.salt, admin.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken({ username: admin.username, role: admin.role, exp: Date.now() + 8 * 3600 * 1000 });
  res.cookie('gh_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  await AuditLog.create({ action: 'ADMIN_LOGIN', details: `Admin ${username} signed in`, actor: username, ip: req.ip });
  res.json({ ok: true, username: admin.username, role: admin.role });
});

app.get('/api/admin/mentors', requireAdmin, async (_req, res) => {
  const [mentors, teams] = await Promise.all([
    Mentor.find().select('-passwordHash -salt').sort({ displayName: 1 }).lean(),
    Team.find().select('teamId facultyMentor progressStatus completionPct').lean()
  ]);
  res.json({ ok: true, mentors, teams });
});

app.post('/api/admin/mentors', requireAdmin, async (req, res) => {
  const { displayName, department, initialPassword } = req.body || {};
  if (!displayName) return res.status(400).json({ error: 'displayName required' });
  const username = normalizeMentorUsername(displayName);
  const { salt, hash } = hashPassword(initialPassword || 'pass123');
  const doc = await Mentor.findOneAndUpdate(
    { username },
    { $setOnInsert: { username, displayName, department: department || '', passwordHash: hash, salt, mustChangePassword: true, active: true } },
    { upsert: true, new: true }
  ).select('-passwordHash -salt');
  await AuditLog.create({ action: 'MENTOR_CREATE', details: `Created mentor ${username}`, actor: req.user.username, ip: req.ip });
  res.json({ ok: true, mentor: doc });
});

app.patch('/api/admin/mentors/:username', requireAdmin, async (req, res) => {
  const username = String(req.params.username || '').toLowerCase().trim();
  const { active, resetPassword, displayName, department } = req.body || {};
  const update = {};
  if (typeof active === 'boolean') update.active = active;
  if (displayName) update.displayName = displayName;
  if (department !== undefined) update.department = department;
  if (resetPassword) {
    const { salt, hash } = hashPassword('pass123');
    update.passwordHash = hash;
    update.salt = salt;
    update.mustChangePassword = true;
  }
  const mentor = await Mentor.findOneAndUpdate({ username }, { $set: update }, { new: true }).select('-passwordHash -salt');
  if (!mentor) return res.status(404).json({ error: 'Mentor not found' });
  await AuditLog.create({ action: 'MENTOR_UPDATE', details: `Updated mentor ${username}`, actor: req.user.username, ip: req.ip });
  res.json({ ok: true, mentor });
});

app.post('/api/admin/mentors/reassign', requireAdmin, async (req, res) => {
  const teamId = normalizeTeamId(req.body?.teamId);
  const facultyMentor = String(req.body?.facultyMentor || '').trim();
  if (!teamId || !facultyMentor) return res.status(400).json({ error: 'teamId and facultyMentor required' });
  const team = await Team.findOneAndUpdate({ teamId }, { $set: { facultyMentor } }, { new: true });
  if (!team) return res.status(404).json({ error: 'Team not found' });
  await syncMentorsFromTeams();
  await AuditLog.create({ action: 'MENTOR_REASSIGN', details: `Reassigned ${teamId} to ${facultyMentor}`, actor: req.user.username, ip: req.ip });
  res.json({ ok: true, team });
});

// ============================================================================
// FACULTY MENTOR PORTAL ROUTES (STRICTLY SCOPED TO LOGGED-IN MENTOR)
// ============================================================================
app.post('/api/mentor/login', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const mentor = await Mentor.findOne({ username });
  if (!mentor || !mentor.active || !verifyPassword(password, mentor.salt, mentor.passwordHash)) {
    return res.status(401).json({ error: 'Invalid mentor credentials or inactive account' });
  }
  mentor.lastLoginAt = new Date();
  mentor.loginCount = (mentor.loginCount || 0) + 1;
  await mentor.save();

  const token = signToken({ username: mentor.username, displayName: mentor.displayName, role: 'faculty_mentor', exp: Date.now() + 8 * 3600 * 1000 });
  res.cookie('gh_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  await AuditLog.create({ action: 'MENTOR_LOGIN', details: `Mentor ${username} signed in`, actor: username, ip: req.ip });
  res.json({ ok: true, username: mentor.username, displayName: mentor.displayName, mustChangePassword: mentor.mustChangePassword });
});

app.post('/api/mentor/change-password', requireMentor, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const mentor = await Mentor.findOne({ username: req.user.username });
  if (!mentor || !verifyPassword(String(currentPassword || ''), mentor.salt, mentor.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const { salt, hash } = hashPassword(String(newPassword));
  mentor.passwordHash = hash;
  mentor.salt = salt;
  mentor.mustChangePassword = false;
  await mentor.save();
  await AuditLog.create({ action: 'MENTOR_PASSWORD_CHANGE', details: `Mentor ${mentor.username} changed password`, actor: mentor.username, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/mentor/teams', requireMentor, async (req, res) => {
  const mentor = await Mentor.findOne({ username: req.user.username }).lean();
  if (!mentor) return res.status(404).json({ error: 'Mentor not found' });

  const teams = await Team.find({ facultyMentor: mentor.displayName }).select('-leaderContact -mentorMobile -accessCodeHash').sort({ teamId: 1 }).lean();
  const teamIds = teams.map(t => t.teamId);
  const latestAlloc = await Allocation.findOne({ status: { $in: ['Published', 'Locked'] } }).sort({ createdAt: -1 }).lean();
  const assignments = latestAlloc ? latestAlloc.assignments.filter(a => teamIds.includes(normalizeTeamId(a.teamId))) : [];
  const gameIds = [...new Set(assignments.map(a => a.gameId))];
  const [games, progressHistory] = await Promise.all([
    Game.find({ gameId: { $in: gameIds } }).lean(),
    ProgressUpdate.find({ teamId: { $in: teamIds } }).sort({ createdAt: -1 }).lean()
  ]);
  res.json({ ok: true, mentor: { username: mentor.username, displayName: mentor.displayName, mustChangePassword: mentor.mustChangePassword }, teams, assignments, games, progressHistory });
});

app.post('/api/mentor/progress', requireMentor, async (req, res) => {
  const teamId = normalizeTeamId(req.body?.teamId);
  const { newStatus, newPct, remarks, feedback, reviewDate } = req.body || {};
  const mentor = await Mentor.findOne({ username: req.user.username }).lean();
  const team = await Team.findOne({ teamId });
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.facultyMentor !== mentor.displayName) {
    return res.status(403).json({ error: 'Forbidden: You can only update progress for your own assigned teams.' });
  }
  const pct = Math.min(100, Math.max(0, Number(newPct) || 0));
  const updateRecord = await ProgressUpdate.create({
    teamId, mentorId: mentor.username, mentorName: mentor.displayName,
    previousStatus: team.progressStatus, newStatus: newStatus || team.progressStatus,
    previousPct: team.completionPct || 0, newPct: pct,
    remarks: remarks || '', feedback: feedback || '', reviewDate: reviewDate || new Date().toISOString().slice(0, 10)
  });
  team.progressStatus = updateRecord.newStatus;
  team.completionPct = pct;
  team.progressRemarks = remarks || '';
  team.lastProgressUpdate = new Date();
  await team.save();
  res.json({ ok: true, update: updateRecord, team });
});

// ============================================================================
// TEAM LEADER PORTAL (READ-ONLY PROGRESS + PUBLISHED ALLOCATION)
// ============================================================================
app.get('/api/portal/team/:teamId', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Database not connected' });
    const teamId = normalizeTeamId(req.params.teamId);
    const team = await Team.findOne({ teamId }).select('-leaderContact -mentorMobile -accessCodeHash').lean();
    if (!team) return res.status(404).json({ error: `Team ${teamId} not found in roster.` });

    const [published, progressHistory, announcements] = await Promise.all([
      Allocation.findOne({ status: { $in: ['Published', 'Locked'] } }).sort({ createdAt: -1 }).lean(),
      ProgressUpdate.find({ teamId }).sort({ createdAt: -1 }).lean(),
      Announcement.find({ target: { $in: ['ALL', teamId] } }).sort({ createdAt: -1 }).lean()
    ]);

    if (!published) return res.json({ team, published: false, games: [], announcements, progressHistory });
    const myIds = published.assignments.filter(a => normalizeTeamId(a.teamId) === teamId).map(a => a.gameId);
    const games = await Game.find({ gameId: { $in: myIds } }).lean();
    res.json({ team, published: true, games, announcements, progressHistory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Import Routes (syncs mentors automatically from imported PDF teams)
app.post('/api/admin/import/teams', requireAdmin, async (req, res) => {
  const incoming = Array.isArray(req.body?.teams) ? req.body.teams : [];
  const seen = new Set(); const duplicateIds = []; const failedRecords = []; const validOps = [];
  for (const raw of incoming) {
    const teamId = normalizeTeamId(raw.teamId || raw.teamNumber);
    if (!/^T\d{3}$/.test(teamId) || !raw.leaderName) { failedRecords.push({ raw, reason: 'Invalid teamId or leaderName' }); continue; }
    if (seen.has(teamId)) { duplicateIds.push(teamId); continue; }
    seen.add(teamId);
    validOps.push({
      updateOne: {
        filter: { teamId },
        update: { $set: { teamId, department: raw.department || '', classSheet: raw.classSheet || '', leaderName: raw.leaderName || '', registerNumber: raw.registerNumber || '', leaderClass: raw.leaderClass || '', leaderContact: raw.leaderContact || '-', facultyMentor: raw.facultyMentor || '', mentorMobile: raw.mentorMobile || '-' } },
        upsert: true
      }
    });
  }
  if (validOps.length > 0) {
    await Team.bulkWrite(validOps);
    await syncMentorsFromTeams();
  }
  const expected = Array.from({ length: 263 }, (_, i) => 'T' + String(i + 1).padStart(3, '0'));
  res.json({ ok: true, stats: { totalExtracted: incoming.length, importedCount: validOps.length, failedCount: failedRecords.length, duplicateCount: duplicateIds.length, missingTeamIds: expected.filter(id => !seen.has(id)) } });
});

app.post('/api/admin/import/games', requireAdmin, async (req, res) => {
  const incoming = Array.isArray(req.body?.games) ? req.body.games : [];
  const ops = incoming.filter(g => g.gameId && g.title).map(g => ({ updateOne: { filter: { gameId: String(g.gameId).trim() }, update: { $set: { ...g, gameId: String(g.gameId).trim() } }, upsert: true } }));
  if (ops.length > 0) await Game.bulkWrite(ops);
  res.json({ ok: true, importedCount: ops.length });
});

app.post('/api/admin/allocations/publish', requireAdmin, async (req, res) => {
  const { version, seed, assignments, teamMeta, sixGameTeams } = req.body || {};
  const [teams, games] = await Promise.all([Team.find().lean(), Game.find().lean()]);
  const normalizedAssignments = (assignments || []).map(a => ({ ...a, teamId: normalizeTeamId(a.teamId || a.teamNumber) }));
  const check = validateAllocationIntegrity(normalizedAssignments, teams, games);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const doc = await Allocation.create({ version, seed, status: 'Published', assignments: normalizedAssignments, teamMeta, sixGameTeams, createdBy: req.user.username });
  await AuditLog.create({ action: 'ALLOC_PUBLISH', details: `Published ${version}`, actor: req.user.username, ip: req.ip });
  res.json({ ok: true, id: doc._id });
});

async function start() {
  if (process.env.MONGODB_URI) {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB Atlas');
  } else {
    console.log('MONGODB_URI not set — running static server + API scaffold');
  }
  app.listen(PORT, () => console.log(`GAMEHUB Server listening on http://localhost:${PORT}`));
}
start().catch(err => { console.error(err); process.exit(1); });
