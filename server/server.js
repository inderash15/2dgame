require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { Game, Team, Allocation, AdminUser, Announcement, AuditLog } = require('./models');

const app = express();
const PORT = process.env.PORT || 4000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// Serve the single-file index.html and project files
app.use(express.static(path.resolve(__dirname, '..')));

// Password hashing (scrypt)
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

// HMAC-signed stateless session token
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

// Auth middleware
function requireAdmin(req, res, next) {
  const token = req.cookies?.gh_session || req.headers.authorization?.replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user || !['admin', 'superadmin'].includes(user.role)) {
    return res.status(401).json({ error: 'Unauthorized: Administrator session required' });
  }
  req.user = user;
  next();
}

// Server-side 172x7 + 91x6 validation
function validateAllocationIntegrity(assignments, teams, games) {
  const gameIds = new Set(games.filter(g => !g.archived).map(g => g.gameId));
  const teamIds = new Set(teams.map(t => t.teamNumber));
  const assignedGames = new Set();
  const counts = Object.fromEntries([...teamIds].map(t => [t, 0]));

  for (const a of assignments) {
    if (!gameIds.has(a.gameId)) return { ok: false, error: `Invalid Game ID: ${a.gameId}` };
    if (!teamIds.has(a.teamNumber)) return { ok: false, error: `Invalid Team ID: ${a.teamNumber}` };
    if (assignedGames.has(a.gameId)) return { ok: false, error: `Duplicate assignment: ${a.gameId}` };
    assignedGames.add(a.gameId);
    counts[a.teamNumber]++;
  }
  const vals = Object.values(counts);
  const t7 = vals.filter(c => c === 7).length;
  const t6 = vals.filter(c => c === 6).length;
  if (assignedGames.size !== 1750 || t7 !== 172 || t6 !== 91) {
    return { ok: false, error: `Integrity failed: ${assignedGames.size}/1750 games, ${t7}/172 seven-game teams, ${t6}/91 six-game teams` };
  }
  return { ok: true };
}

// Auth Routes
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

// Public / Team Leader Portal Route (never exposes contact numbers or unpublished drafts)
app.get('/api/portal/team/:teamNumber', async (req, res) => {
  const teamNumber = String(req.params.teamNumber || '').toUpperCase().trim();
  const team = await Team.findOne({ teamNumber }).select('-leaderContact -mentorMobile -accessCodeHash').lean();
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const published = await Allocation.findOne({ status: { $in: ['Published', 'Locked'] } }).sort({ createdAt: -1 }).lean();
  if (!published) return res.json({ team, published: false, games: [] });

  const myIds = published.assignments.filter(a => a.teamNumber === teamNumber).map(a => a.gameId);
  const games = await Game.find({ gameId: { $in: myIds } }).lean();
  const announcements = await Announcement.find({ target: { $in: ['ALL', teamNumber] } }).sort({ createdAt: -1 }).lean();
  res.json({ team, published: true, games, announcements });
});

// Protected Admin Routes
app.post('/api/admin/allocations/publish', requireAdmin, async (req, res) => {
  const { version, seed, assignments, teamMeta, sixGameTeams } = req.body || {};
  const [teams, games] = await Promise.all([Team.find().lean(), Game.find().lean()]);
  const check = validateAllocationIntegrity(assignments || [], teams, games);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const doc = await Allocation.create({
    version, seed, status: 'Published', assignments, teamMeta, sixGameTeams, createdBy: req.user.username
  });
  await AuditLog.create({ action: 'ALLOC_PUBLISH', details: `Published ${version}`, actor: req.user.username, ip: req.ip });
  res.json({ ok: true, id: doc._id });
});

// Start Server
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
