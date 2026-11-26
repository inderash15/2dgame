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
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// Serve static frontend files
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

function requireAdmin(req, res, next) {
  const token = req.cookies?.gh_session || req.headers.authorization?.replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user || !['admin', 'superadmin'].includes(user.role)) {
    return res.status(401).json({ error: 'Unauthorized: Administrator session required' });
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

// Health check
app.get('/api/health', async (_req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const teamCount = dbReady ? await Team.countDocuments() : 0;
  const gameCount = dbReady ? await Game.countDocuments() : 0;
  res.json({ ok: true, dbConnected: dbReady, teamCount, gameCount });
});

// Admin Login
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

// Public Team Leader Portal Lookup (consistent teamId field)
app.get('/api/portal/team/:teamId', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    const teamId = normalizeTeamId(req.params.teamId);
    const team = await Team.findOne({ teamId }).select('-leaderContact -mentorMobile -accessCodeHash').lean();
    if (!team) {
      return res.status(404).json({ error: `Team ${teamId} not found in roster.` });
    }

    const published = await Allocation.findOne({ status: { $in: ['Published', 'Locked'] } }).sort({ createdAt: -1 }).lean();
    if (!published) {
      return res.json({ team, published: false, games: [], announcements: [] });
    }

    const myIds = published.assignments.filter(a => normalizeTeamId(a.teamId) === teamId).map(a => a.gameId);
    const games = await Game.find({ gameId: { $in: myIds } }).lean();
    const announcements = await Announcement.find({ target: { $in: ['ALL', teamId] } }).sort({ createdAt: -1 }).lean();
    res.json({ team, published: true, games, announcements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Import 263 Teams with duplicate/missing/failed tracking
app.post('/api/admin/import/teams', requireAdmin, async (req, res) => {
  const incoming = Array.isArray(req.body?.teams) ? req.body.teams : [];
  const seen = new Set();
  const duplicateIds = [];
  const failedRecords = [];
  const validOps = [];

  for (const raw of incoming) {
    const teamId = normalizeTeamId(raw.teamId || raw.teamNumber);
    if (!/^T\d{3}$/.test(teamId) || !raw.leaderName) {
      failedRecords.push({ raw, reason: 'Invalid teamId or missing leaderName' });
      continue;
    }
    if (seen.has(teamId)) {
      duplicateIds.push(teamId);
      continue;
    }
    seen.add(teamId);
    validOps.push({
      updateOne: {
        filter: { teamId },
        update: {
          $set: {
            teamId,
            department: raw.department || '',
            classSheet: raw.classSheet || '',
            leaderName: raw.leaderName || '',
            registerNumber: raw.registerNumber || '',
            leaderClass: raw.leaderClass || '',
            leaderContact: raw.leaderContact || '-',
            facultyMentor: raw.facultyMentor || '',
            mentorMobile: raw.mentorMobile || '-'
          }
        },
        upsert: true
      }
    });
  }

  if (validOps.length > 0) await Team.bulkWrite(validOps);
  const expected = Array.from({ length: 263 }, (_, i) => 'T' + String(i + 1).padStart(3, '0'));
  const missingTeamIds = expected.filter(id => !seen.has(id));

  await AuditLog.create({
    action: 'TEAM_ROSTER_IMPORT',
    details: `Imported ${validOps.length}/263 teams (${duplicateIds.length} duplicates, ${failedRecords.length} failed)`,
    actor: req.user.username,
    ip: req.ip
  });

  res.json({
    ok: true,
    stats: {
      totalExtracted: incoming.length,
      importedCount: validOps.length,
      failedCount: failedRecords.length,
      duplicateCount: duplicateIds.length,
      missingTeamIds
    }
  });
});

// Admin: Import 1,750 Games
app.post('/api/admin/import/games', requireAdmin, async (req, res) => {
  const incoming = Array.isArray(req.body?.games) ? req.body.games : [];
  const ops = incoming.filter(g => g.gameId && g.title).map(g => ({
    updateOne: {
      filter: { gameId: String(g.gameId).trim() },
      update: { $set: { ...g, gameId: String(g.gameId).trim() } },
      upsert: true
    }
  }));
  if (ops.length > 0) await Game.bulkWrite(ops);
  await AuditLog.create({ action: 'GAMES_IMPORT', details: `Imported ${ops.length} games`, actor: req.user.username, ip: req.ip });
  res.json({ ok: true, importedCount: ops.length });
});

// Admin: Publish Allocation
app.post('/api/admin/allocations/publish', requireAdmin, async (req, res) => {
  const { version, seed, assignments, teamMeta, sixGameTeams } = req.body || {};
  const [teams, games] = await Promise.all([Team.find().lean(), Game.find().lean()]);
  const normalizedAssignments = (assignments || []).map(a => ({ ...a, teamId: normalizeTeamId(a.teamId || a.teamNumber) }));
  const check = validateAllocationIntegrity(normalizedAssignments, teams, games);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const doc = await Allocation.create({
    version, seed, status: 'Published', assignments: normalizedAssignments, teamMeta, sixGameTeams, createdBy: req.user.username
  });
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
