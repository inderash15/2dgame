const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
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

// Trust Render / reverse proxy for accurate client IP in rate limiting
app.set('trust proxy', 1);

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

// ============================================================================
// STRUCTURED LOGGING, REQUEST ID & NOSQL INJECTION SANITIZATION
// ============================================================================
function stripDollarKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripDollarKeys);
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('$') || k.includes('.')) continue;
    clean[k] = stripDollarKeys(v);
  }
  return clean;
}

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  if (req.body && typeof req.body === 'object') req.body = stripDollarKeys(req.body);
  if (req.query && typeof req.query === 'object') req.query = stripDollarKeys(req.query);
  const start = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(), requestId: req.requestId, method: req.method,
        path: req.originalUrl, status: res.statusCode, ms: Date.now() - start, ip: req.ip
      }));
    }
  });
  next();
});

// ============================================================================
// CONFIGURABLE GRANULAR API RATE LIMITERS
// ============================================================================
function getSessionUser(req) {
  const token = req.cookies?.gh_session || req.headers.authorization?.replace('Bearer ', '');
  return verifyToken(token);
}

const makeLimiter = ({ windowMs, max, name, keyBy = 'userOrIp' }) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (keyBy === 'userOrIp') {
      const u = getSessionUser(req);
      if (u && u.username) return `${u.role}:${u.username}`;
    }
    return req.ip || 'unknown';
  },
  handler: (req, res, _next, options) => {
    const retrySec = Math.ceil(options.windowMs / 1000);
    res.setHeader('Retry-After', String(retrySec));
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), event: 'RATE_LIMIT_EXCEEDED', limiter: name,
      requestId: req.requestId, path: req.originalUrl, ip: req.ip
    }));
    res.status(429).json({
      error: `Too many requests on ${name}. Please retry after ${retrySec} seconds.`,
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterSeconds: retrySec
    });
  }
});

const rlStandard = makeLimiter({ windowMs: 60 * 1000, max: Number(process.env.RL_STANDARD_MAX) || 120, name: 'standard' });
const rlDashboard = makeLimiter({ windowMs: 60 * 1000, max: Number(process.env.RL_DASHBOARD_MAX) || 60, name: 'dashboard' });
const rlSearch = makeLimiter({ windowMs: 60 * 1000, max: Number(process.env.RL_SEARCH_MAX) || 60, name: 'search' });
const rlAuth = makeLimiter({ windowMs: 15 * 60 * 1000, max: Number(process.env.RL_AUTH_MAX) || 5, name: 'login', keyBy: 'ip' });
const rlPassReset = makeLimiter({ windowMs: 60 * 60 * 1000, max: Number(process.env.RL_PASS_RESET_MAX) || 3, name: 'password-reset' });
const rlAdminSensitive = makeLimiter({ windowMs: 60 * 1000, max: Number(process.env.RL_ADMIN_SENSITIVE_MAX) || 30, name: 'admin-sensitive' });
const rlImport = makeLimiter({ windowMs: 15 * 60 * 1000, max: Number(process.env.RL_IMPORT_MAX) || 5, name: 'import' });
const rlProgress = makeLimiter({ windowMs: 60 * 1000, max: Number(process.env.RL_PROGRESS_MAX) || 30, name: 'progress' });

app.use('/api/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api/', rlStandard);
app.use(express.static(path.resolve(__dirname, '..')));

// ============================================================================
// HELPERS & CRYPTO
// ============================================================================
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
  try {
    if (!token || !token.includes('.')) return null;
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch { return null; }
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

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Lightweight TTL cache for read-heavy catalog/published allocations (invalidated on writes)
const MemCache = {
  store: new Map(),
  get(k) {
    const e = this.store.get(k);
    if (!e) return null;
    if (Date.now() > e.exp) { this.store.delete(k); return null; }
    return e.val;
  },
  set(k, val, ttlMs = 30000) { this.store.set(k, { val, exp: Date.now() + ttlMs }); },
  invalidate(prefix = '') {
    for (const k of this.store.keys()) if (!prefix || k.startsWith(prefix)) this.store.delete(k);
  }
};

// ============================================================================
// HEALTH & READINESS PROBES
// ============================================================================
app.get('/api/health', asyncHandler(async (_req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const [teamCount, gameCount, mentorCount] = dbReady
    ? await Promise.all([Team.countDocuments(), Game.countDocuments(), Mentor.countDocuments()])
    : [0, 0, 0];
  res.json({ ok: true, dbConnected: dbReady, teamCount, gameCount, mentorCount, uptimeSec: Math.round(process.uptime()) });
}));

app.get('/api/ready', (_req, res) => {
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ ready: false, reason: 'Database not connected' });
  res.json({ ready: true });
});

// ============================================================================
// PAGINATED CATALOG & ADMIN DASHBOARD ENDPOINTS
// ============================================================================
app.get('/api/games', rlSearch, asyncHandler(async (req, res) => {
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Database not connected' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const filter = { archived: req.query.archived === 'true' };
  if (req.query.genre) filter.genre = String(req.query.genre);
  if (req.query.difficulty) filter.difficulty = String(req.query.difficulty);
  if (req.query.q) {
    const re = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ gameId: re }, { title: re }, { coreMechanic: re }];
  }
  const cacheKey = `games:${page}:${limit}:${req.query.genre||''}:${req.query.difficulty||''}:${req.query.q||''}:${req.query.archived||'false'}`;
  const cached = MemCache.get(cacheKey);
  if (cached) return res.json(cached);
  const [total, items] = await Promise.all([
    Game.countDocuments(filter),
    Game.find(filter).sort({ gameId: 1 }).skip((page - 1) * limit).limit(limit).lean()
  ]);
  const payload = { ok: true, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), items };
  MemCache.set(cacheKey, payload, 30000);
  res.json(payload);
}));

app.get('/api/admin/dashboard', requireAdmin, rlDashboard, asyncHandler(async (_req, res) => {
  const [totalGames, totalTeams, totalMentors, latestAlloc, progressAgg] = await Promise.all([
    Game.countDocuments({ archived: false }),
    Team.countDocuments(),
    Mentor.countDocuments(),
    Allocation.findOne({ status: { $in: ['Published', 'Locked'] } }).sort({ createdAt: -1 }).select('version status').lean(),
    Team.aggregate([{ $group: { _id: '$progressStatus', count: { $sum: 1 } } }])
  ]);
  res.json({ ok: true, totalGames, totalTeams, totalMentors, publishedVersion: latestAlloc?.version || null, progressBreakdown: progressAgg });
}));

app.get('/api/admin/progress', requireAdmin, rlDashboard, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const filter = {};
  if (req.query.mentor) filter.facultyMentor = String(req.query.mentor);
  if (req.query.department) filter.department = String(req.query.department);
  if (req.query.status) filter.progressStatus = String(req.query.status);
  const [total, items] = await Promise.all([
    Team.countDocuments(filter),
    Team.find(filter).select('-accessCodeHash').sort({ teamId: 1 }).skip((page - 1) * limit).limit(limit).lean()
  ]);
  res.json({ ok: true, page, limit, total, items });
}));

// ============================================================================
// ADMIN AUTH & MANAGEMENT ROUTES
// ============================================================================
app.post('/api/auth/login', rlAuth, asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const admin = await AdminUser.findOne({ username: String(username).trim() });
  if (!admin || !verifyPassword(String(password), admin.salt, admin.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken({ username: admin.username, role: admin.role, exp: Date.now() + 8 * 3600 * 1000 });
  res.cookie('gh_session', token, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  await AuditLog.create({ action: 'ADMIN_LOGIN', details: `Admin ${admin.username} signed in`, actor: admin.username, ip: req.ip });
  res.json({ ok: true, username: admin.username, role: admin.role });
}));

app.get('/api/admin/mentors', requireAdmin, rlDashboard, asyncHandler(async (_req, res) => {
  const [mentors, teams] = await Promise.all([
    Mentor.find().select('-passwordHash -salt').sort({ displayName: 1 }).lean(),
    Team.find().select('teamId facultyMentor progressStatus completionPct').lean()
  ]);
  res.json({ ok: true, mentors, teams });
}));

app.post('/api/admin/mentors', requireAdmin, rlAdminSensitive, asyncHandler(async (req, res) => {
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
}));

app.patch('/api/admin/mentors/:username', requireAdmin, rlAdminSensitive, asyncHandler(async (req, res) => {
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
}));

app.post('/api/admin/mentors/reassign', requireAdmin, rlAdminSensitive, asyncHandler(async (req, res) => {
  const teamId = normalizeTeamId(req.body?.teamId);
  const facultyMentor = String(req.body?.facultyMentor || '').trim();
  if (!teamId || !facultyMentor) return res.status(400).json({ error: 'teamId and facultyMentor required' });
  const team = await Team.findOneAndUpdate({ teamId }, { $set: { facultyMentor } }, { new: true });
  if (!team) return res.status(404).json({ error: 'Team not found' });
  await syncMentorsFromTeams();
  await AuditLog.create({ action: 'MENTOR_REASSIGN', details: `Reassigned ${teamId} to ${facultyMentor}`, actor: req.user.username, ip: req.ip });
  res.json({ ok: true, team });
}));

// ============================================================================
// FACULTY MENTOR PORTAL ROUTES
// ============================================================================
app.post('/api/mentor/login', rlAuth, asyncHandler(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const mentor = await Mentor.findOne({ username });
  if (!mentor || !mentor.active || !verifyPassword(password, mentor.salt, mentor.passwordHash)) {
    return res.status(401).json({ error: 'Invalid mentor credentials or inactive account' });
  }
  mentor.lastLoginAt = new Date();
  mentor.loginCount = (mentor.loginCount || 0) + 1;
  await mentor.save();

  const token = signToken({ username: mentor.username, displayName: mentor.displayName, role: 'faculty_mentor', exp: Date.now() + 8 * 3600 * 1000 });
  res.cookie('gh_session', token, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  await AuditLog.create({ action: 'MENTOR_LOGIN', details: `Mentor ${username} signed in`, actor: username, ip: req.ip });
  res.json({ ok: true, username: mentor.username, displayName: mentor.displayName, mustChangePassword: mentor.mustChangePassword });
}));

app.post('/api/mentor/change-password', requireMentor, rlPassReset, asyncHandler(async (req, res) => {
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
}));

app.get('/api/mentor/teams', requireMentor, rlDashboard, asyncHandler(async (req, res) => {
  const mentor = await Mentor.findOne({ username: req.user.username }).lean();
  if (!mentor) return res.status(404).json({ error: 'Mentor not found' });

  const teams = await Team.find({ facultyMentor: mentor.displayName }).select('-leaderContact -mentorMobile -accessCodeHash').sort({ teamId: 1 }).lean();
  const teamIds = teams.map(t => t.teamId);
  const latestAlloc = await Allocation.findOne({ status: { $in: ['Published', 'Locked'] } }).sort({ createdAt: -1 }).lean();
  const assignments = latestAlloc ? latestAlloc.assignments.filter(a => teamIds.includes(normalizeTeamId(a.teamId))) : [];
  const gameIds = [...new Set(assignments.map(a => a.gameId))];
  const [games, progressHistory] = await Promise.all([
    Game.find({ gameId: { $in: gameIds } }).lean(),
    ProgressUpdate.find({ teamId: { $in: teamIds } }).sort({ createdAt: -1 }).limit(100).lean()
  ]);
  res.json({ ok: true, mentor: { username: mentor.username, displayName: mentor.displayName, mustChangePassword: mentor.mustChangePassword }, teams, assignments, games, progressHistory });
}));

app.post('/api/mentor/progress', requireMentor, rlProgress, asyncHandler(async (req, res) => {
  const teamId = normalizeTeamId(req.body?.teamId);
  const { newStatus, newPct, remarks, feedback, reviewDate } = req.body || {};
  const validStatuses = ['Not Started', 'Planning', 'Development In Progress', 'Testing', 'Completed', 'Submitted'];
  if (newStatus && !validStatuses.includes(newStatus)) return res.status(400).json({ error: 'Invalid project status' });

  const mentor = await Mentor.findOne({ username: req.user.username }).lean();
  const team = await Team.findOne({ teamId });
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.facultyMentor !== mentor.displayName) {
    return res.status(403).json({ error: 'Forbidden: You can only update progress for your own assigned teams.' });
  }

  const pct = Math.min(100, Math.max(0, Number(newPct) || 0));
  // Prevent duplicate identical progress submissions within 5 seconds
  const recentDup = await ProgressUpdate.findOne({
    teamId, mentorId: mentor.username, newStatus: newStatus || team.progressStatus, newPct: pct,
    createdAt: { $gte: new Date(Date.now() - 5000) }
  }).lean();
  if (recentDup) return res.json({ ok: true, deduplicated: true, update: recentDup, team });

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
  MemCache.invalidate(`portal:${teamId}`);
  res.json({ ok: true, update: updateRecord, team });
}));

// ============================================================================
// TEAM LEADER PORTAL
// ============================================================================
app.get('/api/portal/team/:teamId', rlSearch, asyncHandler(async (req, res) => {
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'Database not connected' });
  const teamId = normalizeTeamId(req.params.teamId);
  if (!/^T\d{3}$/.test(teamId)) return res.status(400).json({ error: 'Invalid Team ID format (expected T001–T263)' });

  const cached = MemCache.get(`portal:${teamId}`);
  if (cached) return res.json(cached);

  const team = await Team.findOne({ teamId }).select('-leaderContact -mentorMobile -accessCodeHash').lean();
  if (!team) return res.status(404).json({ error: `Team ${teamId} not found in roster.` });

  let published = MemCache.get('pubAlloc');
  if (!published) {
    published = await Allocation.findOne({ status: { $in: ['Published', 'Locked'] } }).sort({ createdAt: -1 }).lean();
    if (published) MemCache.set('pubAlloc', published, 60000);
  }
  const [progressHistory, announcements] = await Promise.all([
    ProgressUpdate.find({ teamId }).sort({ createdAt: -1 }).limit(20).lean(),
    Announcement.find({ target: { $in: ['ALL', teamId] } }).sort({ createdAt: -1 }).limit(20).lean()
  ]);

  if (!published) {
    const p0 = { team, published: false, games: [], announcements, progressHistory };
    MemCache.set(`portal:${teamId}`, p0, 15000);
    return res.json(p0);
  }
  const myIds = published.assignments.filter(a => normalizeTeamId(a.teamId) === teamId).map(a => a.gameId);
  const games = await Game.find({ gameId: { $in: myIds } }).lean();
  const payload = { team, published: true, games, announcements, progressHistory };
  MemCache.set(`portal:${teamId}`, payload, 30000);
  res.json(payload);
}));

// ============================================================================
// ADMIN IMPORT & PUBLISH
// ============================================================================
app.post('/api/admin/import/teams', requireAdmin, rlImport, asyncHandler(async (req, res) => {
  const incoming = Array.isArray(req.body?.teams) ? req.body.teams : [];
  const seen = new Set(); const duplicateIds = []; const failedRecords = []; const validOps = [];
  for (const raw of incoming) {
    const teamId = normalizeTeamId(raw.teamId || raw.teamNumber);
    if (!/^T\d{3}$/.test(teamId) || !raw.leaderName) { failedRecords.push({ reason: 'Invalid teamId or leaderName' }); continue; }
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
}));

app.post('/api/admin/import/games', requireAdmin, rlImport, asyncHandler(async (req, res) => {
  const incoming = Array.isArray(req.body?.games) ? req.body.games : [];
  const ops = incoming.filter(g => g.gameId && g.title).map(g => ({ updateOne: { filter: { gameId: String(g.gameId).trim() }, update: { $set: { ...g, gameId: String(g.gameId).trim() } }, upsert: true } }));
  if (ops.length > 0) await Game.bulkWrite(ops);
  res.json({ ok: true, importedCount: ops.length });
}));

app.post('/api/admin/allocations/publish', requireAdmin, rlAdminSensitive, asyncHandler(async (req, res) => {
  const { version, seed, assignments, teamMeta, sixGameTeams } = req.body || {};
  if (!version) return res.status(400).json({ error: 'Allocation version required' });
  const existingVer = await Allocation.findOne({ version, status: { $in: ['Published', 'Locked'] } }).lean();
  if (existingVer) return res.status(409).json({ error: `Allocation ${version} is already published.` });

  const [teams, games] = await Promise.all([Team.find().lean(), Game.find().lean()]);
  const normalizedAssignments = (assignments || []).map(a => ({ ...a, teamId: normalizeTeamId(a.teamId || a.teamNumber) }));
  const check = validateAllocationIntegrity(normalizedAssignments, teams, games);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const doc = await Allocation.create({ version, seed, status: 'Published', assignments: normalizedAssignments, teamMeta, sixGameTeams, createdBy: req.user.username });
  MemCache.invalidate();
  await AuditLog.create({ action: 'ALLOC_PUBLISH', details: `Published ${version}`, actor: req.user.username, ip: req.ip });
  res.json({ ok: true, id: doc._id });
}));

// Centralized Error Handler (never leaks stack traces in production)
app.use((err, req, res, _next) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), requestId: req.requestId, error: err.message }));
  const status = err.status || (err.message === 'Not allowed by CORS' ? 403 : 500);
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' && status === 500 ? 'Internal server error' : err.message,
    requestId: req.requestId
  });
});

let httpServer = null;
async function start() {
  if (process.env.MONGODB_URI) {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 25,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 20000
    });
    console.log('Connected to MongoDB Atlas (pool 5-25)');
  } else {
    console.log('MONGODB_URI not set — running static server + API scaffold');
  }
  httpServer = app.listen(PORT, () => console.log(`GAMEHUB Server listening on http://localhost:${PORT}`));
}

async function shutdown(sig) {
  console.log(`Received ${sig}, shutting down gracefully...`);
  if (httpServer) await new Promise(r => httpServer.close(r));
  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
