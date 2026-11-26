'use strict';
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ========================================================================
   1. UTILITIES
   ======================================================================== */
const Utils = {
  escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  },
  normalizeTeamNumber(input) {
    const cleaned = String(input || '').trim().toUpperCase().replace(/^TEAM\s*/i, '').replace(/[\s\-_]+/g, '');
    const m = cleaned.match(/^T?0*(\d{1,3})$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 999) return 'T' + String(n).padStart(3, '0');
    }
    return String(input || '').trim().toUpperCase();
  },
  debounce(fn, wait = 180) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
  },
  diffBadgeClass(d) {
    const v = (d || '').toLowerCase();
    return v === 'easy' ? 'badge-green' : v === 'hard' ? 'badge-rose' : 'badge-amber';
  },
  hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  },
  toast(msg, type = 'info') {
    const c = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 220); }, 4000);
  }
};

/* ========================================================================
   2. INDEXEDDB STORAGE & APPLICATION STATE
   ======================================================================== */
const LS_KEYS = { ADMIN_AUTH: 'gh_demo_admin_v3', ADMIN_SESSION: 'gh_demo_sess_v3', THEME: 'gh_theme_v3' };

const AppState = {
  games: [],
  teams: [],
  allocations: [],
  teamMeta: {},
  sixGameTeams: [],
  allocationVersions: [],
  teamProgress: {},
  announcements: [],
  auditHistory: [],
  settings: {
    platformName: 'GAMEHUB',
    institutionName: 'School of Intelligent Systems & Data Science — 2D Game Event',
    academicYear: '2026–27',
    publicPortalEnabled: true,
    shuffleSeed: 'SOISDS-2026-SEED-01',
    weights: { category: 25, difficulty: 20, mechanic: 20, department: 15, concept: 10, feasibility: 10 },
    published: false,
    locked: false
  },
  pendingExcelGames: null,
  pendingPdfTeams: null
};

const DataRepository = {
  db: null,
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('GameHub_Enterprise_DB', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  async get(key, fallback) {
    if (!this.db) return fallback;
    return new Promise((res) => {
      const r = this.db.transaction('kv', 'readonly').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result ? r.result.value : fallback);
      r.onerror = () => res(fallback);
    });
  },
  async set(key, value) {
    if (!this.db) return;
    return new Promise((res, rej) => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key, value });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async loadAll() {
    for (const k of ['games','teams','allocations','teamMeta','sixGameTeams','allocationVersions','teamProgress','announcements','auditHistory']) {
      AppState[k] = await this.get(k, AppState[k]);
    }
    const savedSettings = await this.get('settings', null);
    if (savedSettings) AppState.settings = { ...AppState.settings, ...savedSettings };
  },
  async saveState(keys = ['games','teams','allocations','teamMeta','sixGameTeams','allocationVersions','teamProgress','announcements','auditHistory','settings']) {
    for (const k of keys) await this.set(k, AppState[k]);
  },
  async logAudit(action, details, actor = 'Admin') {
    AppState.auditHistory.unshift({ timestamp: new Date().toISOString(), action, details, actor });
    if (AppState.auditHistory.length > 500) AppState.auditHistory.length = 500;
    await this.set('auditHistory', AppState.auditHistory);
  }
};

/* ========================================================================
   3. AUTHENTICATION (LOCAL PROTOTYPE)
   ======================================================================== */
const AuthModule = {
  isAuthenticated() {
    try { return Boolean(JSON.parse(sessionStorage.getItem(LS_KEYS.ADMIN_SESSION) || 'null')?.authenticated); } catch { return false; }
  },
  renderAuthView() {
    const has = Boolean(localStorage.getItem(LS_KEYS.ADMIN_AUTH));
    document.getElementById('adminSetupForm').style.display = has ? 'none' : 'block';
    document.getElementById('adminLoginForm').style.display = has ? 'block' : 'none';
  },
  hashPass(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  },
  handleSetup(e) {
    e.preventDefault();
    const u = document.getElementById('setupUsername').value.trim();
    const p = document.getElementById('setupPassword').value;
    localStorage.setItem(LS_KEYS.ADMIN_AUTH, JSON.stringify({ username: u, hash: this.hashPass(p) }));
    sessionStorage.setItem(LS_KEYS.ADMIN_SESSION, JSON.stringify({ authenticated: true, username: u }));
    this.syncNav(); App.navigate('admin-dashboard'); Utils.toast('Local admin configured.', 'success');
  },
  handleLogin(e) {
    e.preventDefault();
    const u = document.getElementById('loginUsername').value.trim();
    const p = document.getElementById('loginPassword').value;
    const st = JSON.parse(localStorage.getItem(LS_KEYS.ADMIN_AUTH) || 'null');
    if (!st || st.username !== u || st.hash !== this.hashPass(p)) { Utils.toast('Invalid credentials.', 'error'); return; }
    sessionStorage.setItem(LS_KEYS.ADMIN_SESSION, JSON.stringify({ authenticated: true, username: u }));
    this.syncNav(); App.navigate('admin-dashboard');
  },
  logout() { sessionStorage.removeItem(LS_KEYS.ADMIN_SESSION); this.syncNav(); App.navigate('home'); },
  resetDemoCredentials() {
    if (!confirm('Reset local demo credentials?')) return;
    localStorage.removeItem(LS_KEYS.ADMIN_AUTH); sessionStorage.removeItem(LS_KEYS.ADMIN_SESSION);
    this.renderAuthView(); this.syncNav();
  },
  syncNav() {
    const ok = this.isAuthenticated();
    document.getElementById('navLoginBtn').style.display = ok ? 'none' : 'inline-flex';
    document.getElementById('navDashboardBtn').style.display = ok ? 'inline-flex' : 'none';
    if (ok) document.getElementById('adminSessionUser').textContent = JSON.parse(sessionStorage.getItem(LS_KEYS.ADMIN_SESSION) || '{}').username || 'admin';
  }
};

/* ========================================================================
   4. EXCEL & PDF IMPORTERS + AUTO-LOAD FROM PROJECT FOLDER
   ======================================================================== */
const ImportHelper = {
  async autoLoadFromProject() {
    try {
      const [xlRes, pdfRes] = await Promise.all([
        fetch('./1750_Unique_Non_Duplicate_2D_Games.xlsx'),
        fetch('./SoISDS-2D_Games_Team_Leaders_with_Mentors_T001-T263-v2.pdf')
      ]);
      if (!xlRes.ok || !pdfRes.ok) throw new Error('HTTP fetch failed. Serve via http://localhost or upload files manually.');
      await ExcelModule.processArrayBuffer(await xlRes.arrayBuffer(), '1750_Unique_Non_Duplicate_2D_Games.xlsx');
      await PdfRosterModule.processArrayBuffer(await pdfRes.arrayBuffer(), 'SoISDS-2D_Games_Team_Leaders_with_Mentors_T001-T263-v2.pdf');
      Utils.toast('Loaded both project source files! Review previews and confirm imports.', 'success');
    } catch (err) {
      Utils.toast(err.message, 'warn');
    }
  }
};

const ExcelModule = {
  async handleFileSelect(e) {
    const f = e.target.files[0]; if (!f) return;
    await this.processArrayBuffer(await f.arrayBuffer(), f.name);
    e.target.value = '';
  },
  async processArrayBuffer(buf, filename) {
    const el = document.getElementById('excelPreviewArea');
    el.innerHTML = `<div class="alert-box alert-info">Parsing ${Utils.escapeHtml(filename)}...</div>`;
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const sheet = wb.getWorksheet('1750 Unique Games') || wb.worksheets[0];
      let headerRowIdx = -1; const colMap = {};
      for (let r = 1; r <= Math.min(15, sheet.rowCount); r++) {
        const vals = [];
        sheet.getRow(r).eachCell((cell, colNum) => vals.push({ colNum, txt: String(cell.text || cell.value || '').trim() }));
        if (vals.some(v => v.txt.toLowerCase() === 'game id') && vals.some(v => v.txt.toLowerCase().includes('game title'))) {
          headerRowIdx = r; vals.forEach(v => { colMap[v.txt.toLowerCase()] = v.colNum; }); break;
        }
      }
      if (headerRowIdx === -1) throw new Error('Header row with "Game ID" and "Game Title" not found.');
      const col = (names) => { for (const n of names) if (colMap[n.toLowerCase()]) return colMap[n.toLowerCase()]; return null; };
      const idx = {
        gameId: col(['Game ID']), sourceTeamId: col(['Team ID']), gameSlot: col(['Game Slot']),
        genre: col(['Genre / Category', 'Genre']), title: col(['Game Title']), coreMechanic: col(['Core Mechanic']),
        description: col(['Game Description']), objective: col(['Gameplay Objective']),
        level1Focus: col(['Level 1 Focus']), level2Focus: col(['Level 2 Focus']),
        implementation2D: col(['2D Implementation']), scope12Hour: col(['12-Hour Scope']),
        difficulty: col(['Difficulty']), conceptOrigin: col(['Concept Origin / Status']),
        originalRef: col(['Original File Reference']), uniquenessCheck: col(['Live Title Uniqueness Check'])
      };
      const parsed = []; const seenIds = new Set(); let dupCount = 0;
      for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const str = (c) => c ? String(row.getCell(c).text || row.getCell(c).value || '').trim() : '';
        const gameId = str(idx.gameId); const title = str(idx.title);
        if (!gameId || !title) continue;
        if (seenIds.has(gameId)) dupCount++;
        seenIds.add(gameId);
        parsed.push({
          gameId, sourceTeamId: str(idx.sourceTeamId), gameSlot: str(idx.gameSlot),
          genre: str(idx.genre) || 'Uncategorized', title, coreMechanic: str(idx.coreMechanic),
          description: str(idx.description), objective: str(idx.objective),
          level1Focus: str(idx.level1Focus), level2Focus: str(idx.level2Focus),
          implementation2D: str(idx.implementation2D), scope12Hour: str(idx.scope12Hour),
          difficulty: str(idx.difficulty) || 'Medium', conceptOrigin: str(idx.conceptOrigin),
          originalRef: str(idx.originalRef), uniquenessCheck: str(idx.uniquenessCheck), archived: false
        });
      }
      AppState.pendingExcelGames = parsed;
      el.innerHTML = `
        <div class="alert-box ${parsed.length === 1750 && dupCount === 0 ? 'alert-success' : 'alert-warn'} mb-2">
          <div><strong>${Utils.escapeHtml(sheet.name)}</strong>: ${parsed.length} games parsed, ${dupCount} duplicate IDs.</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="ExcelModule.confirmImport()">Confirm & Import ${parsed.length} Games</button>
      `;
    } catch (err) {
      el.innerHTML = `<div class="alert-box alert-danger">${Utils.escapeHtml(err.message)}</div>`;
    }
  },
  async confirmImport() {
    if (!AppState.pendingExcelGames) return;
    if (AppState.settings.locked && !confirm('Allocation is LOCKED. Replacing games will unlock and reset allocations. Continue?')) return;
    AppState.games = AppState.pendingExcelGames;
    AppState.pendingExcelGames = null;
    AppState.allocations = []; AppState.settings.locked = false; AppState.settings.published = false;
    await DataRepository.saveState(['games','allocations','settings']);
    await DataRepository.logAudit('EXCEL_IMPORT', `Imported ${AppState.games.length} games.`);
    document.getElementById('excelPreviewArea').innerHTML = `<div class="alert-box alert-success">Saved ${AppState.games.length} games!</div>`;
    App.refreshAllUI();
  }
};

const PdfRosterModule = {
  async handleFileSelect(e) {
    const f = e.target.files[0]; if (!f) return;
    await this.processArrayBuffer(await f.arrayBuffer(), f.name);
    e.target.value = '';
  },
  async processArrayBuffer(buf, filename) {
    const el = document.getElementById('pdfVerificationArea');
    el.innerHTML = `<div class="alert-box alert-info">Parsing ${Utils.escapeHtml(filename)}...</div>`;
    try {
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const teamMap = new Map();
      let lastMentor = ''; let lastMentorMobile = '';
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const lines = [];
        for (const item of content.items) {
          const str = (item.str || '').trim(); if (!str) continue;
          const x = item.transform[4], y = item.transform[5];
          let line = lines.find(l => Math.abs(l.y - y) < 3.5);
          if (!line) { line = { y, items: [] }; lines.push(line); }
          line.items.push({ x, str });
        }
        lines.sort((a, b) => b.y - a.y);
        lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
        const pageText = lines.map(l => l.items.map(i => i.str).join(' ')).join('\n');
        if (/Grouped by Faculty Mentor/i.test(pageText) && teamMap.size >= 263) continue;

        let anchors = null;
        for (const l of lines) {
          const joined = l.items.map(i => i.str).join(' ');
          if (/Team\s*No/i.test(joined) && /Team\s*Leader/i.test(joined)) { anchors = this.detectAnchors(l.items); continue; }
          if (!anchors) continue;
          const tItem = l.items.find(i => /^T\d{3}$/i.test(i.str.trim()));
          if (!tItem) continue;
          const row = this.bin(l.items, anchors);
          const teamNumber = Utils.normalizeTeamNumber(row.teamNo || tItem.str);
          let mentor = (row.facultyMentor || '').trim();
          let mentorMobile = (row.mentorMobile || '').trim();
          if (!mentor && lastMentor) { mentor = lastMentor; mentorMobile = mentorMobile || lastMentorMobile; }
          else if (mentor) { lastMentor = mentor; lastMentorMobile = mentorMobile; }
          if (!teamMap.has(teamNumber)) {
            teamMap.set(teamNumber, {
              sno: row.sno || '', department: row.department || '', classSheet: row.classSheet || '',
              teamNumber, leaderName: row.teamLeader || '', registerNumber: row.registerNo || '',
              leaderClass: row.leaderClass || '', leaderContact: row.leaderContact || '-',
              facultyMentor: mentor, mentorMobile: mentorMobile || '-', accessCode: ''
            });
          }
        }
      }
      const teams = Array.from(teamMap.values()).sort((a, b) => a.teamNumber.localeCompare(b.teamNumber));
      AppState.pendingPdfTeams = teams;
      el.innerHTML = `
        <div class="alert-box ${teams.length === 263 ? 'alert-success' : 'alert-warn'} mb-2">
          <div>Extracted <strong>${teams.length} / 263</strong> teams (T001–T263).</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="PdfRosterModule.confirmImport()">Approve & Import ${teams.length} Teams</button>
      `;
    } catch (err) {
      el.innerHTML = `<div class="alert-box alert-danger">${Utils.escapeHtml(err.message)}</div>`;
    }
  },
  detectAnchors(items) {
    const fx = (re, fb) => (items.find(i => re.test(i.str))?.x ?? fb);
    return {
      sno: fx(/^S\.?No/i, 20), department: fx(/^Department/i, 50), classSheet: fx(/^Class\s*Sheet/i, 110),
      teamNo: fx(/^Team\s*No/i, 180), teamLeader: fx(/^Team\s*Leader/i, 230), registerNo: fx(/^Roll|Register/i, 360),
      leaderClass: fx(/^Leader\s*Class/i, 440), leaderContact: fx(/^Leader\s*Contact/i, 530),
      facultyMentor: fx(/^Faculty\s*Mentor/i, 610), mentorMobile: fx(/^Mentor\s*Mobile/i, 710)
    };
  },
  bin(items, anchors) {
    const cols = Object.entries(anchors).sort((a, b) => a[1] - b[1]);
    const out = {}; cols.forEach(([k]) => { out[k] = []; });
    for (const it of items) {
      let bk = cols[0][0];
      for (let i = 0; i < cols.length; i++) {
        const [k, ax] = cols[i]; const nx = i + 1 < cols.length ? cols[i + 1][1] : Infinity;
        if (it.x >= ax - 12 && it.x < nx - 12) { bk = k; break; }
      }
      out[bk].push(it.str);
    }
    const res = {}; for (const k of Object.keys(out)) res[k] = out[k].join(' ').trim(); return res;
  },
  async confirmImport() {
    if (!AppState.pendingPdfTeams) return;
    if (AppState.settings.locked && !confirm('Allocation is LOCKED. Replacing roster will unlock and reset allocations. Continue?')) return;
    AppState.teams = AppState.pendingPdfTeams; AppState.pendingPdfTeams = null;
    AppState.allocations = []; AppState.settings.locked = false; AppState.settings.published = false;
    AllocationEngine.autoSelectSixGameTeams();
    await DataRepository.saveState(['teams','sixGameTeams','allocations','settings']);
    await DataRepository.logAudit('PDF_IMPORT', `Imported ${AppState.teams.length} teams (T001–T263).`);
    document.getElementById('pdfVerificationArea').innerHTML = `<div class="alert-box alert-success">Saved ${AppState.teams.length} teams!</div>`;
    App.refreshAllUI();
  }
};

/* ========================================================================
   5. SEEDED INTELLIGENT ALLOCATION ENGINE (172 x 7 + 91 x 6 = 1,750)
   ======================================================================== */
const AllocationEngine = {
  STOPWORDS: new Set(['the','and','for','with','that','this','from','into','while','each','both','stages','level','players','player','control','using','before','without','letting','around','across','inside','under']),

  autoSelectSixGameTeams() {
    const teams = [...AppState.teams].sort((a, b) => a.teamNumber.localeCompare(b.teamNumber));
    if (teams.length !== 263) {
      AppState.sixGameTeams = teams.slice(0, Math.round(teams.length * (91 / 263))).map(t => t.teamNumber);
      return;
    }
    const groups = new Map();
    teams.forEach(t => {
      const k = `${t.department}::${t.classSheet}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    });
    const selected = []; const rems = [];
    for (const [k, list] of groups.entries()) {
      const exact = (list.length / 263) * 91;
      const floor = Math.floor(exact);
      const step = list.length / Math.max(1, floor);
      for (let i = 0; i < floor; i++) selected.push(list[Math.min(list.length - 1, Math.floor(i * step + step / 2))].teamNumber);
      rems.push({ list, rem: exact - floor });
    }
    rems.sort((a, b) => b.rem - a.rem);
    for (const r of rems) {
      if (selected.length >= 91) break;
      const cand = r.list.find(t => !selected.includes(t.teamNumber));
      if (cand) selected.push(cand.teamNumber);
    }
    AppState.sixGameTeams = selected.slice(0, 91).sort();
  },
  getTeamQuota(tNo) { return AppState.sixGameTeams.includes(tNo) ? 6 : 7; },
  extractTokens(txt) { return new Set(String(txt||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 3 && !this.STOPWORDS.has(w))); },
  extractMechStem(m) { return String(m||'').split('(')[0].trim().toLowerCase(); },
  deptAffinity(dept, g) {
    const d = (dept||'').toUpperCase(), gen = (g.genre||'').toLowerCase();
    if (d.includes('AI') || d.includes('ML')) return ['logic','simulation','strategy','cyber','puzzle','resource'].some(k => gen.includes(k)) ? 1.0 : 0.6;
    if (d.includes('CS') || d.includes('DS')) return ['puzzle','simulation','logic','action-puzzle','physics','resource','strategy'].some(k => gen.includes(k)) ? 1.0 : 0.6;
    return 0.7;
  },
  score(g, team, bucket, quota, w) {
    const wSum = (w.category + w.difficulty + w.mechanic + w.department + w.concept + w.feasibility) || 100;
    const catCount = bucket.filter(x => x.genre === g.genre).length;
    const catS = catCount === 0 ? 1.0 : Math.max(0, 1.0 - catCount * 0.65);
    const tgt = quota === 7 ? { Easy: 2, Medium: 3, Hard: 2 } : { Easy: 2, Medium: 2, Hard: 2 };
    const curD = bucket.filter(x => x.difficulty === g.difficulty).length;
    const diffS = curD < (tgt[g.difficulty] || 2) ? 1.0 : 0.3;
    const mechS = bucket.some(x => x._mech === g._mech) ? 0.0 : 1.0;
    const deptS = this.deptAffinity(team.department, g);
    let maxSim = 0;
    for (const cg of bucket) {
      let inter = 0; for (const tok of g._tok) if (cg._tok.has(tok)) inter++;
      const un = g._tok.size + cg._tok.size - inter;
      if (un > 0) maxSim = Math.max(maxSim, inter / un);
    }
    const conS = 1.0 - Math.min(1, maxSim * 2.2);
    const feasS = /two distinct playable levels/i.test(g.scope12Hour) ? 0.95 : 0.75;
    return catS*(w.category/wSum) + diffS*(w.difficulty/wSum) + mechS*(w.mechanic/wSum) + deptS*(w.department/wSum) + conS*(w.concept/wSum) + feasS*(w.feasibility/wSum);
  },
  runGlobalOptimization(weights, seedStr) {
    const activeGames = AppState.games.filter(g => !g.archived);
    if (activeGames.length !== 1750) throw new Error(`Need 1,750 active games (found ${activeGames.length}).`);
    if (AppState.teams.length !== 263) throw new Error(`Need 263 teams (found ${AppState.teams.length}).`);
    if (AppState.sixGameTeams.length !== 91) throw new Error(`Need 91 six-game teams (found ${AppState.sixGameTeams.length}).`);

    const rng = Utils.hashSeed(seedStr || 'DEFAULT-SEED');
    const games = activeGames.map(g => ({
      ...g, _mech: this.extractMechStem(g.coreMechanic), _tok: this.extractTokens(`${g.title} ${g.description}`), _r: rng()
    })).sort((a, b) => a._r - b._r); // Seeded shuffle!

    const teams = [...AppState.teams].sort((a, b) => a.teamNumber.localeCompare(b.teamNumber));
    const buckets = new Map(teams.map(t => [t.teamNumber, []]));
    const unassigned = new Set(games.map((_, i) => i));

    for (let round = 0; round < 7; round++) {
      const order = round % 2 === 0 ? teams : [...teams].reverse();
      for (const team of order) {
        const quota = this.getTeamQuota(team.teamNumber);
        const bucket = buckets.get(team.teamNumber);
        if (bucket.length >= quota) continue;
        let bestIdx = -1, bestSc = -Infinity;
        for (const i of unassigned) {
          const sc = this.score(games[i], team, bucket, quota, weights);
          if (sc > bestSc) { bestSc = sc; bestIdx = i; }
        }
        if (bestIdx !== -1) { bucket.push(games[bestIdx]); unassigned.delete(bestIdx); }
      }
    }

    const now = new Date().toISOString();
    const allocations = []; const teamMeta = {};
    for (const team of teams) {
      const bucket = buckets.get(team.teamNumber);
      const cats = new Set(bucket.map(g => g.genre)).size;
      const mechs = new Set(bucket.map(g => g._mech)).size;
      const diffs = { Easy: 0, Medium: 0, Hard: 0 };
      bucket.forEach(g => { diffs[g.difficulty] = (diffs[g.difficulty] || 0) + 1; });
      const sc = Math.min(99, Math.round(70 + (cats / bucket.length) * 15 + (mechs / bucket.length) * 14));
      teamMeta[team.teamNumber] = {
        score: sc,
        explanation: `${cats}/${bucket.length} genres, ${diffs.Easy}E/${diffs.Medium}M/${diffs.Hard}H, ${mechs}/${bucket.length} mechanics, soft ${team.department} fit.`
      };
      bucket.forEach(g => allocations.push({ gameId: g.gameId, teamNumber: team.teamNumber, allocatedAt: now }));
    }
    return { allocations, teamMeta };
  }
};

/* ========================================================================
   6. VALIDATION ENGINE (11 DATA INTEGRITY RULES)
   ======================================================================== */
const ValidationEngine = {
  validateAll() {
    const activeGames = AppState.games.filter(g => !g.archived);
    const gameIds = new Set(activeGames.map(g => g.gameId));
    const teamIds = new Set(AppState.teams.map(t => t.teamNumber));
    const allocGames = new Set(); let dupAlloc = 0, invalidTeamRefs = 0;
    const counts = {}; AppState.teams.forEach(t => { counts[t.teamNumber] = 0; });

    for (const a of AppState.allocations) {
      if (allocGames.has(a.gameId)) dupAlloc++;
      allocGames.add(a.gameId);
      if (counts[a.teamNumber] !== undefined) counts[a.teamNumber]++; else invalidTeamRefs++;
    }
    const vals = Object.values(counts);
    const t7 = vals.filter(c => c === 7).length;
    const t6 = vals.filter(c => c === 6).length;
    const under6 = vals.filter(c => c < 6).length;
    const over7 = vals.filter(c => c > 7).length;

    const checks = [
      { name: 'Exactly 1,750 valid game records', pass: activeGames.length === 1750, detail: `${activeGames.length}/1750` },
      { name: 'Exactly 263 valid team records', pass: AppState.teams.length === 263, detail: `${AppState.teams.length}/263` },
      { name: 'Every Game ID is unique', pass: gameIds.size === activeGames.length && activeGames.length > 0, detail: `${activeGames.length - gameIds.size} dupes` },
      { name: 'Every Team ID is unique', pass: teamIds.size === AppState.teams.length && AppState.teams.length > 0, detail: `${AppState.teams.length - teamIds.size} dupes` },
      { name: 'Every game is assigned once', pass: dupAlloc === 0 && AppState.allocations.length === 1750, detail: `${dupAlloc} conflicts` },
      { name: 'No team receives < 6 games', pass: AppState.teams.length === 263 && under6 === 0, detail: `${under6} teams` },
      { name: 'No team receives > 7 games', pass: AppState.teams.length === 263 && over7 === 0, detail: `${over7} teams` },
      { name: 'Exactly 172 teams receive 7 games', pass: t7 === 172, detail: `${t7}/172` },
      { name: 'Exactly 91 teams receive 6 games', pass: t6 === 91, detail: `${t6}/91` },
      { name: 'No missing game assignments', pass: allocGames.size === 1750, detail: `${1750 - allocGames.size} missing` },
      { name: 'No invalid team references', pass: invalidTeamRefs === 0, detail: `${invalidTeamRefs} invalid` }
    ];
    return { allPassed: checks.every(c => c.pass), checks, t7, t6 };
  }
};

/* ========================================================================
   7. TEAM LEADER PORTAL (PUBLIC — RESPECTS PUBLISHED STATUS & PRIVACY)
   ======================================================================== */
const UserPortal = {
  currentTeam: null, currentGames: [],
  handleHeroLookup(e) {
    e.preventDefault();
    const raw = document.getElementById('heroTeamInput').value;
    document.getElementById('lookupTeamInput').value = raw;
    App.navigate('lookup'); this.lookupTeam(raw);
  },
  handleLookupSubmit(e) { e.preventDefault(); this.lookupTeam(document.getElementById('lookupTeamInput').value); },
  clearLookup() { document.getElementById('lookupTeamInput').value = ''; this.currentTeam = null; this.currentGames = []; },
  lookupTeam(raw) {
    const area = document.getElementById('lookupResultArea');
    if (!AppState.settings.publicPortalEnabled) {
      area.innerHTML = `<div class="alert-box alert-warn">Team Leader Portal is currently disabled by the Administrator.</div>`; return;
    }
    const tNo = Utils.normalizeTeamNumber(raw);
    const team = AppState.teams.find(t => t.teamNumber === tNo);
    if (!team) { area.innerHTML = `<div class="alert-box alert-danger">Team <strong>${Utils.escapeHtml(tNo)}</strong> not found in roster.</div>`; return; }

    const code = document.getElementById('lookupAccessCode')?.value || '';
    if (team.accessCode && code !== team.accessCode) {
      area.innerHTML = `<div class="alert-box alert-danger">Invalid Team Access Code for ${Utils.escapeHtml(tNo)}.</div>`; return;
    }

    const isPub = AppState.settings.published;
    const gameMap = new Map(AppState.games.map(g => [g.gameId, g]));
    const assigned = isPub ? AppState.allocations.filter(a => a.teamNumber === tNo).map(a => gameMap.get(a.gameId)).filter(Boolean) : [];
    this.currentTeam = team; this.currentGames = assigned;

    const prog = AppState.teamProgress[tNo] || { status: 'Not Started', remarks: '' };
    const anns = AppState.announcements.filter(a => a.target === 'ALL' || a.target === tNo);
    const cats = [...new Set(assigned.map(g => g.genre))].sort();

    area.innerHTML = `
      ${anns.length ? `<div class="mb-2">${anns.map(a => `<div class="alert-box alert-info mb-1"><div><strong>[${Utils.escapeHtml(a.priority)}] ${Utils.escapeHtml(a.title)}:</strong> ${Utils.escapeHtml(a.body)}</div></div>`).join('')}</div>` : ''}
      <div class="surface-card mb-3" style="padding:1.4rem;">
        <div class="flex-between mb-2">
          <div class="flex-center">
            <span class="badge badge-purple">${Utils.escapeHtml(team.teamNumber)}</span>
            <span class="badge ${isPub ? 'badge-green' : 'badge-amber'}">${isPub ? 'Published (' + assigned.length + ' Games)' : 'Pending Publication'}</span>
            <span class="badge badge-cyan">Progress: ${Utils.escapeHtml(prog.status)}</span>
          </div>
          <div class="flex-center no-print">
            <button class="btn btn-secondary btn-sm" onclick="ExportModule.exportTeamPDF('${Utils.escapeHtml(team.teamNumber)}')"><i data-lucide="file-down" width="15"></i> Download Team PDF</button>
            <button class="btn btn-secondary btn-sm" onclick="window.print()"><i data-lucide="printer" width="15"></i> Print</button>
          </div>
        </div>
        <div class="grid-3">
          <div><div class="text-xs text-muted">TEAM ID</div><strong>${Utils.escapeHtml(team.teamNumber)}</strong></div>
          <div><div class="text-xs text-muted">TEAM LEADER</div><strong>${Utils.escapeHtml(team.leaderName)}</strong></div>
          <div><div class="text-xs text-muted">DEPARTMENT</div><strong>${Utils.escapeHtml(team.department)}</strong></div>
          <div><div class="text-xs text-muted">CLASS</div><strong>${Utils.escapeHtml(team.leaderClass || team.classSheet)}</strong></div>
          <div><div class="text-xs text-muted">FACULTY MENTOR</div><strong>${Utils.escapeHtml(team.facultyMentor)}</strong></div>
          <div><div class="text-xs text-muted">TOTAL ASSIGNED GAMES</div><strong>${assigned.length}</strong></div>
        </div>
      </div>
      ${!isPub ? `<div class="alert-box alert-warn">Allocations are currently in Draft mode and have not been published by the Administrator yet.</div>` : `
        <div class="surface-card mb-2 no-print" style="padding:1rem;">
          <div class="grid-3">
            <input type="text" id="portalSearchTitle" class="form-control" placeholder="Search assigned games..." oninput="UserPortal.renderGames()" />
            <select id="portalFilterCat" class="form-control" onchange="UserPortal.renderGames()"><option value="">All Genres</option>${cats.map(c=>`<option value="${Utils.escapeHtml(c)}">${Utils.escapeHtml(c)}</option>`).join('')}</select>
            <select id="portalFilterDiff" class="form-control" onchange="UserPortal.renderGames()"><option value="">All Difficulties</option><option value="Easy">Easy</option><option value="Medium">Medium</option><option value="Hard">Hard</option></select>
          </div>
        </div>
        <div id="portalGamesGrid" class="games-grid"></div>
      `}
    `;
    if (isPub) this.renderGames();
    lucide.createIcons();
  },
  renderGames() {
    const q = (document.getElementById('portalSearchTitle')?.value || '').toLowerCase();
    const cat = document.getElementById('portalFilterCat')?.value || '';
    const diff = document.getElementById('portalFilterDiff')?.value || '';
    const list = this.currentGames.filter(g => (!q || g.title.toLowerCase().includes(q) || g.gameId.toLowerCase().includes(q)) && (!cat || g.genre === cat) && (!diff || g.difficulty === diff));
    document.getElementById('portalGamesGrid').innerHTML = list.map(g => GameCardHTML(g)).join('') || `<div class="empty-state">No games match filter.</div>`;
    lucide.createIcons();
  }
};

function GameCardHTML(g) {
  return `
    <div class="surface-card interactive game-card">
      <div>
        <div class="flex-between"><span class="badge badge-purple mono">${Utils.escapeHtml(g.gameId)}</span><span class="badge ${Utils.diffBadgeClass(g.difficulty)}">${Utils.escapeHtml(g.difficulty)}</span></div>
        <h3 class="game-card-title">${Utils.escapeHtml(g.title)}</h3>
        <span class="badge badge-blue mb-1">${Utils.escapeHtml(g.genre)}</span>
        <div class="text-xs text-muted mb-1"><strong>Mechanic:</strong> ${Utils.escapeHtml(g.coreMechanic)}</div>
        <p class="game-card-desc">${Utils.escapeHtml(g.description)}</p>
      </div>
      <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="ModalUI.openGame('${Utils.escapeHtml(g.gameId)}')">View Full Details</button>
    </div>`;
}

const ModalUI = {
  openGame(gid) {
    const g = AppState.games.find(x => x.gameId === gid); if (!g) return;
    document.getElementById('modalTitle').textContent = `${g.gameId}: ${g.title}`;
    const fields = [
      ['Genre / Category', g.genre], ['Difficulty', g.difficulty], ['Core Mechanic', g.coreMechanic],
      ['Game Description', g.description], ['Gameplay Objective', g.objective],
      ['Level 1 Focus', g.level1Focus], ['Level 2 Focus', g.level2Focus],
      ['2D Implementation', g.implementation2D], ['12-Hour Scope', g.scope12Hour]
    ];
    document.getElementById('modalBody').innerHTML = fields.map(([k, v]) => `
      <div class="mb-1" style="padding:0.65rem; border:1px solid var(--border-subtle); border-radius:8px;">
        <div class="text-xs text-muted">${Utils.escapeHtml(k)}</div>
        <div class="text-sm">${Utils.escapeHtml(v || '—')}</div>
      </div>`).join('');
    document.getElementById('genericModal').classList.add('open');
  },
  openCustom(title, html) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = html;
    document.getElementById('genericModal').classList.add('open');
    lucide.createIcons();
  },
  close() { document.getElementById('genericModal').classList.remove('open'); }
};

/* ========================================================================
   8. ADMIN MODULES (OVERVIEW, GAMES, TEAMS, ALLOCATION, HISTORY, PROGRESS, ANNOUNCEMENTS, EXPORTS, SETTINGS)
   ======================================================================== */
const LibraryModule = {
  pageSize: 24, debouncedRender: null,
  init() { this.debouncedRender = Utils.debounce(() => this.render(1), 180); },
  refreshFilters() {
    const active = AppState.games.filter(g => !g.archived);
    const cats = [...new Set(active.map(g => g.genre))].sort();
    const sel = document.getElementById('libCategoryFilter'); const cur = sel.value;
    sel.innerHTML = `<option value="">All Genres</option>` + cats.map(c => `<option value="${Utils.escapeHtml(c)}">${Utils.escapeHtml(c)}</option>`).join('');
    sel.value = cur;
    document.getElementById('libraryCountBadge').textContent = `${active.length} Games`;
  },
  render(page = 1) {
    const q = (document.getElementById('libSearchInput').value || '').toLowerCase();
    const cat = document.getElementById('libCategoryFilter').value;
    const diff = document.getElementById('libDifficultyFilter').value;
    const sort = document.getElementById('libSortSelect').value;
    let list = AppState.games.filter(g => !g.archived && (!q || g.title.toLowerCase().includes(q) || g.gameId.toLowerCase().includes(q) || g.coreMechanic.toLowerCase().includes(q)) && (!cat || g.genre === cat) && (!diff || g.difficulty === diff));
    if (sort === 'title_asc') list.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'title_desc') list.sort((a, b) => b.title.localeCompare(a.title));
    else list.sort((a, b) => a.gameId.localeCompare(b.gameId));
    const total = Math.max(1, Math.ceil(list.length / this.pageSize)); page = Math.min(Math.max(1, page), total);
    document.getElementById('libraryGrid').innerHTML = list.slice((page - 1) * this.pageSize, page * this.pageSize).map(GameCardHTML).join('') || `<div class="empty-state">No games found.</div>`;
    document.getElementById('libraryPagination').innerHTML = `<button class="btn btn-secondary btn-sm" ${page<=1?'disabled':''} onclick="LibraryModule.render(${page-1})">Prev</button><span class="text-sm text-muted">Page ${page}/${total}</span><button class="btn btn-secondary btn-sm" ${page>=total?'disabled':''} onclick="LibraryModule.render(${page+1})">Next</button>`;
  }
};

const AdminUI = {
  charts: {},
  toggleSidebar() { document.getElementById('adminShell').classList.toggle('collapsed'); },
  switchTab(tab) {
    document.querySelectorAll('.sidebar-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.id === `admin-tab-${tab}`));
    const label = document.querySelector(`.sidebar-btn[data-tab="${tab}"] .sidebar-label`)?.textContent || tab;
    document.getElementById('adminBreadcrumb').textContent = label;
    if (tab === 'overview') this.renderOverview();
    if (tab === 'games') GameManager.render(1);
    if (tab === 'teams') TeamManager.render(1);
    if (tab === 'alloc-control') AllocationUI.render();
    if (tab === 'alloc-history') AllocationHistoryModule.render();
    if (tab === 'progress') ProgressModule.render();
    if (tab === 'announcements') AnnouncementModule.render();
    if (tab === 'reports-export') ReportsModule.render();
    if (tab === 'audit') AuditModule.render();
    if (tab === 'settings') SettingsModule.render();
    lucide.createIcons();
  },
  renderOverview() {
    const val = ValidationEngine.validateAll();
    const totalG = AppState.games.filter(g => !g.archived).length;
    const allocG = AppState.allocations.length;
    const pubG = AppState.settings.published ? allocG : 0;
    const pendG = AppState.settings.published ? 0 : allocG;

    document.getElementById('kpiTotalGames').textContent = totalG;
    document.getElementById('kpiTotalTeams').textContent = AppState.teams.length;
    document.getElementById('kpiAssignedGames').textContent = allocG;
    document.getElementById('kpiUnassignedGames').textContent = Math.max(0, totalG - allocG);
    document.getElementById('kpiPublishedCount').textContent = pubG;
    document.getElementById('kpiPendingCount').textContent = pendG;
    document.getElementById('kpiTeams6').textContent = val.t6;
    document.getElementById('kpiTeams7').textContent = val.t7;
    document.getElementById('kpiCompletionPct').textContent = totalG ? Math.round((allocG / totalG) * 100) + '%' : '0%';
    document.getElementById('kpiValidationStatus').textContent = val.allPassed ? 'PASSED' : 'Incomplete';
    document.getElementById('kpiValidationStatus').style.color = val.allPassed ? '#34d399' : '#fbbf24';

    document.getElementById('adminPubBadge').textContent = AppState.settings.published ? 'Published' : 'Draft';
    document.getElementById('adminPubBadge').className = `badge ${AppState.settings.published ? 'badge-green' : 'badge-blue'}`;
    document.getElementById('adminLockBadge').textContent = AppState.settings.locked ? 'Locked' : 'Unlocked';
    document.getElementById('adminLockBadge').className = `badge ${AppState.settings.locked ? 'badge-green' : 'badge-amber'}`;
    document.getElementById('adminNotifCount').textContent = AppState.announcements.length;

    if (!window.Chart) return;
    const mk = (id, type, labels, data, colors) => {
      if (this.charts[id]) this.charts[id].destroy();
      this.charts[id] = new Chart(document.getElementById(id), {
        type, data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, borderRadius: 5 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: type === 'doughnut', labels: { color: '#94a3b8' } } }, scales: type === 'bar' ? { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } : {} }
      });
    };

    const genres = {}; AppState.games.forEach(g => { genres[g.genre] = (genres[g.genre] || 0) + 1; });
    const topG = Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 12);
    mk('chartGenre', 'bar', topG.map(x => x[0]), topG.map(x => x[1]), '#8b5cf6');

    const diffs = { Easy: 0, Medium: 0, Hard: 0 }; AppState.games.forEach(g => { diffs[g.difficulty] = (diffs[g.difficulty] || 0) + 1; });
    mk('chartDifficulty', 'doughnut', Object.keys(diffs), Object.values(diffs), ['#10b981', '#f59e0b', '#f43f5e']);

    mk('chartAllocDist', 'doughnut', ['7-Game Teams', '6-Game Teams'], [val.t7, val.t6], ['#3b82f6', '#8b5cf6']);

    const tCounts = {}; AppState.allocations.forEach(a => { tCounts[a.teamNumber] = (tCounts[a.teamNumber] || 0) + 1; });
    const sampleT = AppState.teams.slice(0, 25).map(t => t.teamNumber);
    mk('chartByTeam', 'bar', sampleT, sampleT.map(t => tCounts[t] || 0), '#06b6d4');

    const dTeams = {}; AppState.teams.forEach(t => { dTeams[t.department] = (dTeams[t.department] || 0) + 1; });
    mk('chartDeptTeams', 'bar', Object.keys(dTeams), Object.values(dTeams), '#10b981');
  }
};

const GameManager = {
  pageSize: 25, debouncedRender: null,
  init() { this.debouncedRender = Utils.debounce(() => this.render(1), 180); },
  render(page = 1) {
    const cats = [...new Set(AppState.games.map(g => g.genre))].sort();
    const cSel = document.getElementById('adminGameCatFilter'); const curC = cSel.value;
    cSel.innerHTML = `<option value="">All Genres</option>` + cats.map(c => `<option value="${Utils.escapeHtml(c)}">${Utils.escapeHtml(c)}</option>`).join('');
    cSel.value = curC;

    const q = (document.getElementById('adminGameSearch').value || '').toLowerCase();
    const diff = document.getElementById('adminGameDiffFilter').value;
    const arch = document.getElementById('adminGameArchiveFilter').value;
    const allocMap = new Map(AppState.allocations.map(a => [a.gameId, a.teamNumber]));

    const list = AppState.games.filter(g => {
      if (arch === 'active' && g.archived) return false;
      if (arch === 'archived' && !g.archived) return false;
      if (q && !g.gameId.toLowerCase().includes(q) && !g.title.toLowerCase().includes(q)) return false;
      if (curC && g.genre !== curC) return false;
      if (diff && g.difficulty !== diff) return false;
      return true;
    });
    const total = Math.max(1, Math.ceil(list.length / this.pageSize)); page = Math.min(Math.max(1, page), total);
    document.getElementById('adminGamesTbody').innerHTML = list.slice((page - 1) * this.pageSize, page * this.pageSize).map(g => {
      const tNo = allocMap.get(g.gameId);
      return `
        <tr>
          <td class="mono">${Utils.escapeHtml(g.gameId)}</td>
          <td><strong>${Utils.escapeHtml(g.title)}</strong></td>
          <td>${Utils.escapeHtml(g.genre)}</td>
          <td><span class="badge ${Utils.diffBadgeClass(g.difficulty)}">${Utils.escapeHtml(g.difficulty)}</span></td>
          <td class="text-xs text-muted">${Utils.escapeHtml(g.coreMechanic)}</td>
          <td>${tNo ? `<span class="badge badge-green mono">${Utils.escapeHtml(tNo)}</span>` : '<span class="badge badge-slate">Unassigned</span>'}</td>
          <td><span class="badge ${g.archived ? 'badge-rose' : 'badge-blue'}">${g.archived ? 'Archived' : 'Active'}</span></td>
          <td class="flex-center">
            <button class="btn btn-secondary btn-sm" onclick="ModalUI.openGame('${Utils.escapeHtml(g.gameId)}')">View</button>
            <button class="btn btn-secondary btn-sm" onclick="GameManager.openEditModal('${Utils.escapeHtml(g.gameId)}')">Edit</button>
            <button class="btn btn-warning btn-sm" onclick="GameManager.toggleArchive('${Utils.escapeHtml(g.gameId)}')">${g.archived ? 'Restore' : 'Archive'}</button>
          </td>
        </tr>`;
    }).join('') || `<tr><td colspan="8" class="text-muted">No games found.</td></tr>`;
    document.getElementById('adminGamesPagination').innerHTML = `<button class="btn btn-secondary btn-sm" ${page<=1?'disabled':''} onclick="GameManager.render(${page-1})">Prev</button><span class="text-sm text-muted">Page ${page}/${total} (${list.length})</span><button class="btn btn-secondary btn-sm" ${page>=total?'disabled':''} onclick="GameManager.render(${page+1})">Next</button>`;
  },
  openEditModal(gid = '') {
    const g = gid ? AppState.games.find(x => x.gameId === gid) : { gameId: '', title: '', genre: 'Puzzle', difficulty: 'Medium', coreMechanic: '', description: '' };
    ModalUI.openCustom(gid ? `Edit ${gid}` : 'Add New Game', `
      <form onsubmit="GameManager.saveGame(event, '${Utils.escapeHtml(gid)}')">
        <div class="grid-2">
          <div class="form-group"><label class="form-label">Game ID</label><input id="edGameId" class="form-control" value="${Utils.escapeHtml(g.gameId)}" ${gid?'readonly':''} required /></div>
          <div class="form-group"><label class="form-label">Title</label><input id="edGameTitle" class="form-control" value="${Utils.escapeHtml(g.title)}" required /></div>
          <div class="form-group"><label class="form-label">Genre</label><input id="edGameGenre" class="form-control" value="${Utils.escapeHtml(g.genre)}" required /></div>
          <div class="form-group"><label class="form-label">Difficulty</label><select id="edGameDiff" class="form-control"><option ${g.difficulty==='Easy'?'selected':''}>Easy</option><option ${g.difficulty==='Medium'?'selected':''}>Medium</option><option ${g.difficulty==='Hard'?'selected':''}>Hard</option></select></div>
        </div>
        <div class="form-group"><label class="form-label">Core Mechanic</label><input id="edGameMech" class="form-control" value="${Utils.escapeHtml(g.coreMechanic)}" /></div>
        <div class="form-group"><label class="form-label">Description</label><textarea id="edGameDesc" class="form-control">${Utils.escapeHtml(g.description)}</textarea></div>
        <button type="submit" class="btn btn-primary">Save Game</button>
      </form>`);
  },
  async saveGame(e, origId) {
    e.preventDefault();
    const obj = {
      gameId: document.getElementById('edGameId').value.trim(),
      title: document.getElementById('edGameTitle').value.trim(),
      genre: document.getElementById('edGameGenre').value.trim(),
      difficulty: document.getElementById('edGameDiff').value,
      coreMechanic: document.getElementById('edGameMech').value.trim(),
      description: document.getElementById('edGameDesc').value.trim()
    };
    if (origId) Object.assign(AppState.games.find(x => x.gameId === origId), obj);
    else AppState.games.push({ ...obj, archived: false });
    await DataRepository.saveState(['games']);
    await DataRepository.logAudit(origId ? 'GAME_EDIT' : 'GAME_ADD', `Saved game ${obj.gameId}: ${obj.title}`);
    ModalUI.close(); this.render(1); App.refreshAllUI();
  },
  async toggleArchive(gid) {
    const g = AppState.games.find(x => x.gameId === gid); if (!g) return;
    g.archived = !g.archived;
    await DataRepository.saveState(['games']);
    await DataRepository.logAudit('GAME_ARCHIVE', `${g.archived ? 'Archived' : 'Restored'} ${gid}`);
    this.render(1); App.refreshAllUI();
  },
  detectDuplicates() {
    const seen = new Map(); const dupes = [];
    AppState.games.forEach(g => {
      const k = g.title.trim().toLowerCase();
      if (seen.has(k)) dupes.push(`${g.gameId} & ${seen.get(k)}: "${g.title}"`);
      else seen.set(k, g.gameId);
    });
    Utils.toast(dupes.length ? `Found ${dupes.length} duplicate titles!` : 'Zero duplicate titles across all games!', dupes.length ? 'warn' : 'success');
  }
};

const TeamManager = {
  pageSize: 30, debouncedRender: null,
  init() { this.debouncedRender = Utils.debounce(() => this.render(1), 180); },
  render(page = 1) {
    const depts = [...new Set(AppState.teams.map(t => t.department))].sort();
    const mentors = [...new Set(AppState.teams.map(t => t.facultyMentor))].sort();
    const dSel = document.getElementById('adminTeamDeptFilter'); const curD = dSel.value;
    dSel.innerHTML = `<option value="">All Departments</option>` + depts.map(d => `<option value="${Utils.escapeHtml(d)}">${Utils.escapeHtml(d)}</option>`).join(''); dSel.value = curD;
    const mSel = document.getElementById('adminTeamMentorFilter'); const curM = mSel.value;
    mSel.innerHTML = `<option value="">All Mentors</option>` + mentors.map(m => `<option value="${Utils.escapeHtml(m)}">${Utils.escapeHtml(m)}</option>`).join(''); mSel.value = curM;

    const q = (document.getElementById('adminTeamSearch').value || '').toLowerCase();
    const qf = document.getElementById('adminTeamQuotaFilter').value;
    const counts = {}; AppState.allocations.forEach(a => { counts[a.teamNumber] = (counts[a.teamNumber] || 0) + 1; });

    const list = AppState.teams.filter(t => {
      const quota = AllocationEngine.getTeamQuota(t.teamNumber);
      if (q && !t.teamNumber.toLowerCase().includes(q) && !t.leaderName.toLowerCase().includes(q) && !t.registerNumber.toLowerCase().includes(q)) return false;
      if (curD && t.department !== curD) return false;
      if (curM && t.facultyMentor !== curM) return false;
      if (qf && String(quota) !== qf) return false;
      return true;
    });
    document.getElementById('adminTeamCountBadge').textContent = `${list.length} Teams`;
    const total = Math.max(1, Math.ceil(list.length / this.pageSize)); page = Math.min(Math.max(1, page), total);
    document.getElementById('adminTeamsTbody').innerHTML = list.slice((page - 1) * this.pageSize, page * this.pageSize).map(t => `
      <tr>
        <td class="mono"><strong>${Utils.escapeHtml(t.teamNumber)}</strong></td>
        <td>${Utils.escapeHtml(t.department)}</td>
        <td>${Utils.escapeHtml(t.leaderName)}</td>
        <td class="mono text-xs">${Utils.escapeHtml(t.registerNumber)}</td>
        <td class="mono text-xs">${Utils.escapeHtml(t.leaderContact)}</td>
        <td>${Utils.escapeHtml(t.facultyMentor)}</td>
        <td class="mono text-xs">${Utils.escapeHtml(t.mentorMobile)}</td>
        <td><span class="badge badge-blue">${counts[t.teamNumber] || 0}/${AllocationEngine.getTeamQuota(t.teamNumber)}</span></td>
        <td><button class="btn btn-secondary btn-sm" onclick="TeamManager.openEdit('${Utils.escapeHtml(t.teamNumber)}')">Edit</button></td>
      </tr>`).join('') || `<tr><td colspan="9" class="text-muted">No teams loaded.</td></tr>`;
    document.getElementById('adminTeamsPagination').innerHTML = `<button class="btn btn-secondary btn-sm" ${page<=1?'disabled':''} onclick="TeamManager.render(${page-1})">Prev</button><span class="text-sm text-muted">Page ${page}/${total}</span><button class="btn btn-secondary btn-sm" ${page>=total?'disabled':''} onclick="TeamManager.render(${page+1})">Next</button>`;
  },
  openEdit(tNo) {
    const t = AppState.teams.find(x => x.teamNumber === tNo); if (!t) return;
    ModalUI.openCustom(`Edit Team ${tNo}`, `
      <form onsubmit="TeamManager.saveEdit(event, '${Utils.escapeHtml(tNo)}')">
        <div class="grid-2">
          <div class="form-group"><label class="form-label">Team Leader</label><input id="edTLeader" class="form-control" value="${Utils.escapeHtml(t.leaderName)}" required /></div>
          <div class="form-group"><label class="form-label">Department</label><input id="edTDept" class="form-control" value="${Utils.escapeHtml(t.department)}" required /></div>
          <div class="form-group"><label class="form-label">Faculty Mentor</label><input id="edTMentor" class="form-control" value="${Utils.escapeHtml(t.facultyMentor)}" required /></div>
          <div class="form-group"><label class="form-label">Optional Access Code</label><input id="edTCode" class="form-control" value="${Utils.escapeHtml(t.accessCode||'')}" placeholder="Blank = open lookup" /></div>
        </div>
        <button type="submit" class="btn btn-primary">Save Team</button>
      </form>`);
  },
  async saveEdit(e, tNo) {
    e.preventDefault();
    const t = AppState.teams.find(x => x.teamNumber === tNo);
    t.leaderName = document.getElementById('edTLeader').value.trim();
    t.department = document.getElementById('edTDept').value.trim();
    t.facultyMentor = document.getElementById('edTMentor').value.trim();
    t.accessCode = document.getElementById('edTCode').value.trim();
    await DataRepository.saveState(['teams']);
    await DataRepository.logAudit('TEAM_EDIT', `Updated team ${tNo}`);
    ModalUI.close(); this.render(1);
  }
};

const AllocationUI = {
  render() {
    document.getElementById('allocSeedInput').value = AppState.settings.shuffleSeed;
    const w = AppState.settings.weights;
    document.getElementById('wCategory').value = w.category; document.getElementById('wDifficulty').value = w.difficulty;
    document.getElementById('wMechanic').value = w.mechanic; document.getElementById('wDepartment').value = w.department;
    document.getElementById('wConcept').value = w.concept; document.getElementById('wFeasibility').value = w.feasibility;
    document.getElementById('policySummaryText').textContent = `6-Game Teams: ${AppState.sixGameTeams.length}/91 | 7-Game Teams: ${Math.max(0, AppState.teams.length - AppState.sixGameTeams.length)}/172`;
    PreviewModule.render(1);
  },
  async autoBalancePolicy() {
    if (AppState.settings.locked) { Utils.toast('Unlock allocation first.', 'warn'); return; }
    AllocationEngine.autoSelectSixGameTeams();
    await DataRepository.saveState(['sixGameTeams']);
    this.render(); Utils.toast('Balanced 91 six-game teams across departments.', 'success');
  },
  async runOptimization() {
    if (AppState.settings.locked && !confirm('Allocation is LOCKED. Unlock and generate new version?')) return;
    const weights = {
      category: +document.getElementById('wCategory').value, difficulty: +document.getElementById('wDifficulty').value,
      mechanic: +document.getElementById('wMechanic').value, department: +document.getElementById('wDepartment').value,
      concept: +document.getElementById('wConcept').value, feasibility: +document.getElementById('wFeasibility').value
    };
    const seed = document.getElementById('allocSeedInput').value.trim() || 'SOISDS-2026';
    AppState.settings.weights = weights; AppState.settings.shuffleSeed = seed;
    AppState.settings.locked = false; AppState.settings.published = false;
    try {
      const { allocations, teamMeta } = AllocationEngine.runGlobalOptimization(weights, seed);
      AppState.allocations = allocations; AppState.teamMeta = teamMeta;
      const ver = 'v' + (AppState.allocationVersions.length + 1);
      AppState.allocationVersions.unshift({
        version: ver, timestamp: new Date().toISOString(), admin: 'Admin', seed,
        summary: `1,750 games → 263 teams (172×7 + 91×6)`, status: 'Draft',
        allocations: JSON.parse(JSON.stringify(allocations)), teamMeta: JSON.parse(JSON.stringify(teamMeta)), sixGameTeams: [...AppState.sixGameTeams]
      });
      await DataRepository.saveState(['allocations','teamMeta','settings','allocationVersions']);
      await DataRepository.logAudit('ALLOC_GENERATE', `Generated ${ver} with seed ${seed}.`);
      this.render(); App.refreshAllUI(); Utils.toast(`Generated ${ver} successfully!`, 'success');
    } catch (err) { Utils.toast(err.message, 'error'); }
  },
  async approveAndPublish() {
    const val = ValidationEngine.validateAll();
    if (!val.allPassed) { Utils.toast('Cannot publish: fix validation failures first.', 'error'); return; }
    AppState.settings.published = true;
    if (AppState.allocationVersions[0]) AppState.allocationVersions[0].status = 'Published';
    await DataRepository.saveState(['settings','allocationVersions']);
    await DataRepository.logAudit('ALLOC_PUBLISH', 'Approved and published allocation to Team Leader Portal.');
    App.refreshAllUI(); Utils.toast('Allocation Approved & Published!', 'success');
  },
  async toggleLock() {
    if (!AppState.settings.locked) {
      const val = ValidationEngine.validateAll();
      if (!val.allPassed) { Utils.toast('Cannot lock: validation incomplete.', 'error'); return; }
      AppState.settings.locked = true;
    } else {
      if (!confirm('Unlock allocation?')) return;
      AppState.settings.locked = false;
    }
    await DataRepository.saveState(['settings']);
    await DataRepository.logAudit(AppState.settings.locked ? 'ALLOC_LOCK' : 'ALLOC_UNLOCK', 'Toggled allocation lock.');
    App.refreshAllUI();
  }
};

const PreviewModule = {
  pageSize: 15, debouncedRender: null,
  init() { this.debouncedRender = Utils.debounce(() => this.render(1), 180); },
  render(page = 1) {
    const val = ValidationEngine.validateAll();
    document.getElementById('validationReportCard').innerHTML = `
      <div class="flex-between mb-1"><h3 class="text-sm">11-Rule Data Integrity Report</h3><span class="badge ${val.allPassed?'badge-green':'badge-rose'}">${val.allPassed?'ALL 11 RULES PASSED':'ACTION REQUIRED'}</span></div>
      <div class="grid-3" style="gap:0.4rem;">${val.checks.map(c=>`<div class="flex-between text-xs" style="padding:0.4rem 0.6rem; border:1px solid ${c.pass?'rgba(16,185,129,0.3)':'rgba(244,63,94,0.3)'}; border-radius:6px;"><span>${c.pass?'✓':'✗'} ${Utils.escapeHtml(c.name)}</span><strong class="mono">${Utils.escapeHtml(c.detail)}</strong></div>`).join('')}</div>`;

    const depts = [...new Set(AppState.teams.map(t => t.department))].sort();
    const mentors = [...new Set(AppState.teams.map(t => t.facultyMentor))].sort();
    const dS = document.getElementById('previewDeptFilter'); const curD = dS.value;
    dS.innerHTML = `<option value="">All Departments</option>` + depts.map(d=>`<option value="${Utils.escapeHtml(d)}">${Utils.escapeHtml(d)}</option>`).join(''); dS.value = curD;
    const mS = document.getElementById('previewMentorFilter'); const curM = mS.value;
    mS.innerHTML = `<option value="">All Mentors</option>` + mentors.map(m=>`<option value="${Utils.escapeHtml(m)}">${Utils.escapeHtml(m)}</option>`).join(''); mS.value = curM;

    const q = (document.getElementById('previewSearchInput').value || '').toLowerCase();
    const cf = document.getElementById('previewCountFilter').value;
    const gMap = new Map(AppState.games.map(g => [g.gameId, g]));
    const byT = new Map();
    AppState.allocations.forEach(a => { if (!byT.has(a.teamNumber)) byT.set(a.teamNumber, []); const g = gMap.get(a.gameId); if (g) byT.get(a.teamNumber).push(g); });

    const list = AppState.teams.filter(t => {
      const gs = byT.get(t.teamNumber) || [];
      if (q && !t.teamNumber.toLowerCase().includes(q) && !t.leaderName.toLowerCase().includes(q) && !t.facultyMentor.toLowerCase().includes(q)) return false;
      if (curD && t.department !== curD) return false;
      if (curM && t.facultyMentor !== curM) return false;
      if (cf && String(gs.length) !== cf) return false;
      return true;
    });
    const total = Math.max(1, Math.ceil(list.length / this.pageSize)); page = Math.min(Math.max(1, page), total);
    document.getElementById('previewTeamsContainer').innerHTML = list.slice((page - 1) * this.pageSize, page * this.pageSize).map(t => {
      const gs = byT.get(t.teamNumber) || [];
      const meta = AppState.teamMeta[t.teamNumber] || { score: 0, explanation: '' };
      return `<div class="surface-card mb-2" style="padding:1rem;">
        <div class="flex-between mb-1"><div><span class="badge badge-purple mono">${Utils.escapeHtml(t.teamNumber)}</span> <strong>${Utils.escapeHtml(t.leaderName)}</strong> <span class="text-xs text-muted">${Utils.escapeHtml(t.department)} · ${Utils.escapeHtml(t.facultyMentor)}</span></div><div><span class="badge badge-blue">${gs.length} Games</span> <span class="badge badge-green">Score: ${meta.score}%</span></div></div>
        <div class="text-xs text-muted mb-1">${Utils.escapeHtml(meta.explanation)}</div>
        <div class="flex-center" style="gap:0.35rem;">${gs.map(g=>`<span class="badge badge-slate">${Utils.escapeHtml(g.gameId)}: ${Utils.escapeHtml(g.title)}</span>`).join('')}</div>
      </div>`;
    }).join('') || `<div class="empty-state">No teams to preview.</div>`;
    document.getElementById('previewPagination').innerHTML = `<button class="btn btn-secondary btn-sm" ${page<=1?'disabled':''} onclick="PreviewModule.render(${page-1})">Prev</button><span class="text-sm text-muted">Page ${page}/${total}</span><button class="btn btn-secondary btn-sm" ${page>=total?'disabled':''} onclick="PreviewModule.render(${page+1})">Next</button>`;
  }
};

const ManualModule = {
  async handleSwap(e) {
    e.preventDefault();
    if (AppState.settings.locked && !confirm('Allocation is LOCKED. Unlock to swap?')) return;
    const idA = document.getElementById('swapGameA').value.trim().toUpperCase();
    const idB = document.getElementById('swapGameB').value.trim().toUpperCase();
    const a1 = AppState.allocations.find(a => a.gameId === idA), a2 = AppState.allocations.find(a => a.gameId === idB);
    if (!a1 || !a2) { Utils.toast('Both Game IDs must be assigned.', 'error'); return; }
    const tmp = a1.teamNumber; a1.teamNumber = a2.teamNumber; a2.teamNumber = tmp;
    AppState.settings.locked = false;
    await DataRepository.saveState(['allocations','settings']);
    await DataRepository.logAudit('MANUAL_SWAP', `Swapped ${idA} and ${idB}`);
    PreviewModule.render(1); App.refreshAllUI(); Utils.toast(`Swapped ${idA} and ${idB}`, 'success');
  },
  async handleReassign(e) {
    e.preventDefault();
    if (AppState.settings.locked && !confirm('Allocation is LOCKED. Unlock to reassign?')) return;
    const gid = document.getElementById('reassignGameId').value.trim().toUpperCase();
    const tNo = Utils.normalizeTeamNumber(document.getElementById('reassignTeamNo').value);
    if (!AppState.games.some(g => g.gameId === gid) || !AppState.teams.some(t => t.teamNumber === tNo)) { Utils.toast('Invalid Game ID or Team ID.', 'error'); return; }
    const ex = AppState.allocations.find(a => a.gameId === gid);
    if (ex) ex.teamNumber = tNo; else AppState.allocations.push({ gameId: gid, teamNumber: tNo, allocatedAt: new Date().toISOString() });
    AppState.settings.locked = false;
    await DataRepository.saveState(['allocations','settings']);
    await DataRepository.logAudit('MANUAL_REASSIGN', `Reassigned ${gid} to ${tNo}`);
    PreviewModule.render(1); App.refreshAllUI(); Utils.toast(`Reassigned ${gid} to ${tNo}`, 'warn');
  }
};

const AllocationHistoryModule = {
  render() {
    document.getElementById('allocHistoryTbody').innerHTML = AppState.allocationVersions.map((v, i) => `
      <tr>
        <td class="mono"><strong>${Utils.escapeHtml(v.version)}</strong></td>
        <td class="text-xs">${Utils.escapeHtml(new Date(v.timestamp).toLocaleString())}</td>
        <td>${Utils.escapeHtml(v.admin)}</td>
        <td class="mono text-xs">${Utils.escapeHtml(v.seed)}</td>
        <td class="text-xs">${Utils.escapeHtml(v.summary)}</td>
        <td><span class="badge ${v.status==='Published'?'badge-green':'badge-blue'}">${Utils.escapeHtml(v.status)}</span></td>
        <td><button class="btn btn-warning btn-sm" onclick="AllocationHistoryModule.rollback(${i})">Rollback</button></td>
      </tr>`).join('') || `<tr><td colspan="7" class="text-muted">No allocation versions yet.</td></tr>`;
  },
  async rollback(idx) {
    const v = AppState.allocationVersions[idx]; if (!v) return;
    if (!confirm(`Rollback allocation to ${v.version} (${v.seed})?`)) return;
    AppState.allocations = JSON.parse(JSON.stringify(v.allocations));
    AppState.teamMeta = JSON.parse(JSON.stringify(v.teamMeta));
    AppState.sixGameTeams = [...v.sixGameTeams];
    AppState.settings.shuffleSeed = v.seed; AppState.settings.locked = false;
    await DataRepository.saveState(['allocations','teamMeta','sixGameTeams','settings']);
    await DataRepository.logAudit('ALLOC_ROLLBACK', `Rolled back to ${v.version}`);
    App.refreshAllUI(); Utils.toast(`Rolled back to ${v.version}`, 'success');
  }
};

const ProgressModule = {
  render() {
    const q = (document.getElementById('progressSearch')?.value || '').toLowerCase();
    const statuses = ['Not Started','Planning','Development in Progress','Testing','Completed','Submitted'];
    document.getElementById('progressTbody').innerHTML = AppState.teams.filter(t => !q || t.teamNumber.toLowerCase().includes(q) || t.leaderName.toLowerCase().includes(q)).slice(0, 60).map(t => {
      const p = AppState.teamProgress[t.teamNumber] || { status: 'Not Started', remarks: '' };
      return `<tr>
        <td class="mono"><strong>${Utils.escapeHtml(t.teamNumber)}</strong></td>
        <td>${Utils.escapeHtml(t.leaderName)}</td>
        <td>${Utils.escapeHtml(t.department)}</td>
        <td><select id="progSt_${t.teamNumber}" class="form-control">${statuses.map(s=>`<option ${p.status===s?'selected':''}>${s}</option>`).join('')}</select></td>
        <td><input id="progRm_${t.teamNumber}" class="form-control" value="${Utils.escapeHtml(p.remarks)}" placeholder="Remarks..." /></td>
        <td><button class="btn btn-secondary btn-sm" onclick="ProgressModule.save('${t.teamNumber}')">Save</button></td>
      </tr>`;
    }).join('');
  },
  async save(tNo) {
    AppState.teamProgress[tNo] = {
      status: document.getElementById(`progSt_${tNo}`).value,
      remarks: document.getElementById(`progRm_${tNo}`).value
    };
    await DataRepository.saveState(['teamProgress']);
    Utils.toast(`Updated progress for ${tNo}`, 'success');
  }
};

const AnnouncementModule = {
  async create(e) {
    e.preventDefault();
    AppState.announcements.unshift({
      id: Date.now().toString(36),
      title: document.getElementById('annTitle').value.trim(),
      body: document.getElementById('annBody').value.trim(),
      priority: document.getElementById('annPriority').value,
      target: document.getElementById('annTarget').value.trim().toUpperCase() || 'ALL',
      start: document.getElementById('annStart').value,
      expiry: document.getElementById('annExpiry').value
    });
    await DataRepository.saveState(['announcements']);
    await DataRepository.logAudit('ANNOUNCEMENT', `Published announcement: ${AppState.announcements[0].title}`);
    e.target.reset(); document.getElementById('annTarget').value = 'ALL';
    this.render(); App.refreshAllUI(); Utils.toast('Announcement published!', 'success');
  },
  render() {
    document.getElementById('adminAnnList').innerHTML = AppState.announcements.map((a, i) => `
      <div style="padding:0.75rem; border:1px solid var(--border-subtle); border-radius:8px;">
        <div class="flex-between"><strong>${Utils.escapeHtml(a.title)}</strong> <button class="btn btn-danger btn-sm" onclick="AnnouncementModule.del(${i})">Delete</button></div>
        <div class="text-xs text-muted">Priority: ${Utils.escapeHtml(a.priority)} | Target: ${Utils.escapeHtml(a.target)}</div>
        <div class="text-sm mt-1">${Utils.escapeHtml(a.body)}</div>
      </div>`).join('') || `<div class="text-sm text-muted">No announcements.</div>`;
  },
  async del(i) {
    AppState.announcements.splice(i, 1);
    await DataRepository.saveState(['announcements']);
    this.render(); App.refreshAllUI();
  }
};

const ReportsModule = {
  render() {
    const depts = {};
    const counts = {}; AppState.allocations.forEach(a => { counts[a.teamNumber] = (counts[a.teamNumber] || 0) + 1; });
    AppState.teams.forEach(t => {
      if (!depts[t.department]) depts[t.department] = { teams: 0, t7: 0, t6: 0, games: 0 };
      const c = counts[t.teamNumber] || 0;
      depts[t.department].teams++; depts[t.department].games += c;
      if (c === 7) depts[t.department].t7++; if (c === 6) depts[t.department].t6++;
    });
    document.getElementById('reportsSummaryArea').innerHTML = `
      <div class="table-wrap"><table><thead><tr><th>Department</th><th>Teams</th><th>7-Game Teams</th><th>6-Game Teams</th><th>Total Games</th></tr></thead>
      <tbody>${Object.entries(depts).map(([d,s])=>`<tr><td><strong>${Utils.escapeHtml(d)}</strong></td><td>${s.teams}</td><td>${s.t7}</td><td>${s.t6}</td><td><strong>${s.games}</strong></td></tr>`).join('')}</tbody></table></div>`;
  }
};

const ExportModule = {
  async dl(wb, name) {
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = name; a.click(); Utils.toast(`Downloaded ${name}`, 'success');
  },
  async exportCompleteWorkbook() {
    const wb = new ExcelJS.Workbook();
    const gMap = new Map(AppState.games.map(g => [g.gameId, g]));
    const tMap = new Map(AppState.teams.map(t => [t.teamNumber, t]));
    const aMap = new Map(AppState.allocations.map(a => [a.gameId, a.teamNumber]));
    const s1 = wb.addWorksheet('1750 Games'); s1.addRow(['Game ID','Assigned Team','Title','Genre','Difficulty','Core Mechanic']);
    AppState.games.forEach(g => s1.addRow([g.gameId, aMap.get(g.gameId)||'UNASSIGNED', g.title, g.genre, g.difficulty, g.coreMechanic]));
    const s2 = wb.addWorksheet('263 Teams'); s2.addRow(['Team ID','Department','Leader','Register No','Faculty Mentor']);
    AppState.teams.forEach(t => s2.addRow([t.teamNumber, t.department, t.leaderName, t.registerNumber, t.facultyMentor]));
    const s3 = wb.addWorksheet('Final Allocation'); s3.addRow(['Team ID','Leader','Dept','Mentor','Game ID','Title','Genre','Difficulty']);
    AppState.allocations.forEach(a => { const t=tMap.get(a.teamNumber)||{}, g=gMap.get(a.gameId)||{}; s3.addRow([a.teamNumber,t.leaderName,t.department,t.facultyMentor,a.gameId,g.title,g.genre,g.difficulty]); });
    const s4 = wb.addWorksheet('Validation'); ValidationEngine.validateAll().checks.forEach(c => s4.addRow([c.name, c.pass?'PASS':'FAIL', c.detail]));
    await this.dl(wb, 'GameHub_Complete_Allocation.xlsx');
  },
  async exportGamesOnly() {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Games');
    ws.addRow(['Game ID','Title','Genre','Difficulty','Core Mechanic']);
    AppState.games.forEach(g => ws.addRow([g.gameId, g.title, g.genre, g.difficulty, g.coreMechanic]));
    await this.dl(wb, 'GameHub_Games_Catalog.xlsx');
  },
  async exportTeamWiseExcel() { await this.exportCompleteWorkbook(); },
  async exportAnalyticsWorkbook() {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Genre & Difficulty');
    ws.addRow(['Genre','Count']);
    const gs = {}; AppState.games.forEach(g => { gs[g.genre] = (gs[g.genre] || 0) + 1; });
    Object.entries(gs).forEach(([k,v]) => ws.addRow([k, v]));
    await this.dl(wb, 'GameHub_Analytics_Report.xlsx');
  },
  exportTeamPDF(overrideTeam) {
    const tNo = Utils.normalizeTeamNumber(overrideTeam || document.getElementById('exportPdfTeamNo')?.value);
    const team = AppState.teams.find(t => t.teamNumber === tNo);
    if (!team) { Utils.toast('Team not found.', 'error'); return; }
    const gMap = new Map(AppState.games.map(g => [g.gameId, g]));
    const games = AppState.allocations.filter(a => a.teamNumber === tNo).map(a => gMap.get(a.gameId)).filter(Boolean);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(16); doc.text(`GAMEHUB — Team ${tNo} Allocation Brief`, 14, 18);
    doc.setFontSize(10); doc.text(`Leader: ${team.leaderName} | Dept: ${team.department} | Mentor: ${team.facultyMentor}`, 14, 26);
    let y = 36;
    games.forEach((g, idx) => {
      if (y > 265) { doc.addPage(); y = 20; }
      doc.setFontSize(11); doc.text(`${idx + 1}. [${g.gameId}] ${g.title} (${g.genre} | ${g.difficulty})`, 14, y); y += 6;
      doc.setFontSize(9); const lines = doc.splitTextToSize(`Mechanic: ${g.coreMechanic} — ${g.description}`, 180);
      doc.text(lines, 14, y); y += lines.length * 4.5 + 4;
    });
    doc.save(`Team_${tNo}_Games.pdf`);
    Utils.toast(`Exported Team_${tNo}_Games.pdf`, 'success');
  },
  exportGameWisePDF() {
    const { jsPDF } = window.jspdf; const doc = new jsPDF();
    doc.setFontSize(14); doc.text('GAMEHUB — Game-Wise Allocation (Sample Top 100)', 14, 16);
    doc.setFontSize(9); let y = 25;
    AppState.allocations.slice(0, 100).forEach(a => {
      if (y > 280) { doc.addPage(); y = 16; }
      doc.text(`${a.gameId} -> ${a.teamNumber}`, 14, y); y += 5;
    });
    doc.save('GameHub_GameWise_Allocation.pdf');
  }
};

const AuditModule = {
  render() {
    document.getElementById('auditHistoryTbody').innerHTML = AppState.auditHistory.map(a => `
      <tr><td class="mono text-xs">${Utils.escapeHtml(new Date(a.timestamp).toLocaleString())}</td><td><span class="badge badge-blue">${Utils.escapeHtml(a.action)}</span></td><td class="text-sm">${Utils.escapeHtml(a.details)}</td><td class="text-xs">${Utils.escapeHtml(a.actor)}</td></tr>
    `).join('') || `<tr><td colspan="4" class="text-muted">No audit logs.</td></tr>`;
  }
};

const SettingsModule = {
  render() {
    document.getElementById('setPlatformName').value = AppState.settings.platformName;
    document.getElementById('setInstName').value = AppState.settings.institutionName;
    document.getElementById('setAcadYear').value = AppState.settings.academicYear;
    document.getElementById('setPublicPortal').value = String(AppState.settings.publicPortalEnabled);
  },
  async save(e) {
    e.preventDefault();
    AppState.settings.platformName = document.getElementById('setPlatformName').value.trim();
    AppState.settings.institutionName = document.getElementById('setInstName').value.trim();
    AppState.settings.academicYear = document.getElementById('setAcadYear').value.trim();
    AppState.settings.publicPortalEnabled = document.getElementById('setPublicPortal').value === 'true';
    await DataRepository.saveState(['settings']);
    App.refreshAllUI(); Utils.toast('Settings saved.', 'success');
  }
};

const BackupModule = {
  exportJSON() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(AppState)], { type: 'application/json' }));
    a.download = `GameHub_Backup_${new Date().toISOString().slice(0, 10)}.json`; a.click();
  },
  async importJSON(e) {
    const f = e.target.files[0]; if (!f) return;
    const d = JSON.parse(await f.text());
    Object.assign(AppState, d); await DataRepository.saveState(); App.refreshAllUI(); Utils.toast('Backup restored!', 'success');
  },
  async clearAllData() {
    if (!confirm('Clear all IndexedDB data?')) return;
    AppState.games=[]; AppState.teams=[]; AppState.allocations=[]; AppState.allocationVersions=[];
    AppState.settings.locked=false; AppState.settings.published=false;
    await DataRepository.saveState(); App.refreshAllUI();
  }
};

const TestSuite = {
  runAll() {
    const val = ValidationEngine.validateAll();
    const t050 = AppState.teams.find(t => t.teamNumber === 'T050');
    const t050G = AppState.allocations.filter(a => a.teamNumber === 'T050').length;
    const tests = [
      ...val.checks,
      { name: 'T050 Lookup & Roster Match', pass: Boolean(t050 && t050G >= 6), detail: t050 ? `${t050.leaderName} (${t050G} games)` : 'Missing' },
      { name: 'ExcelJS & jsPDF Engines Ready', pass: typeof ExcelJS !== 'undefined' && typeof window.jspdf !== 'undefined', detail: 'Ready' }
    ];
    const passed = tests.filter(t => t.pass).length;
    document.getElementById('testSuiteResults').innerHTML = `
      <div class="alert-box ${passed === tests.length ? 'alert-success' : 'alert-warn'} mb-2"><strong>${passed} / ${tests.length} Checks Passed</strong></div>
      <div class="table-wrap"><table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>${tests.map(t=>`<tr><td>${Utils.escapeHtml(t.name)}</td><td><span class="badge ${t.pass?'badge-green':'badge-rose'}">${t.pass?'PASS':'FAIL'}</span></td><td class="mono text-xs">${Utils.escapeHtml(t.detail)}</td></tr>`).join('')}</tbody></table></div>`;
  }
};

/* ========================================================================
   9. APP CONTROLLER
   ======================================================================== */
const App = {
  async init() {
    if (localStorage.getItem(LS_KEYS.THEME) === 'light') document.documentElement.classList.replace('dark', 'light');
    await DataRepository.init();
    await DataRepository.loadAll();
    LibraryModule.init(); GameManager.init(); TeamManager.init(); PreviewModule.init();
    AuthModule.syncNav(); AuthModule.renderAuthView(); this.refreshAllUI();
    document.getElementById('mobileMenuToggle').addEventListener('click', () => document.getElementById('mainNavLinks').classList.toggle('open'));
    lucide.createIcons();
  },
  toggleTheme() {
    const isDark = document.documentElement.classList.contains('dark');
    document.documentElement.classList.replace(isDark ? 'dark' : 'light', isDark ? 'light' : 'dark');
    localStorage.setItem(LS_KEYS.THEME, isDark ? 'light' : 'dark');
  },
  navigate(sec) {
    if (sec === 'admin-dashboard' && !AuthModule.isAuthenticated()) sec = 'admin-login';
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`section-${sec}`)?.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === sec));
    document.getElementById('mainNavLinks').classList.remove('open');
    if (sec === 'admin-login') AuthModule.renderAuthView();
    if (sec === 'admin-dashboard') AdminUI.renderOverview();
    if (sec === 'library') { LibraryModule.refreshFilters(); LibraryModule.render(1); }
    lucide.createIcons();
  },
  refreshAllUI() {
    document.getElementById('brandPlatformName').textContent = AppState.settings.platformName;
    document.getElementById('brandAcadYear').textContent = AppState.settings.academicYear;
    document.getElementById('heroInstitutionLabel').textContent = AppState.settings.institutionName;
    document.getElementById('homeStatGames').textContent = AppState.games.filter(g => !g.archived).length;
    document.getElementById('homeStatTeams').textContent = AppState.teams.length;
    document.getElementById('homeStatAllocated').textContent = AppState.allocations.length;
    document.getElementById('homeStatPublishStatus').textContent = AppState.settings.published ? 'Published' : 'Draft';
    document.getElementById('homeOnboardingBanner').style.display = (AppState.games.length === 1750 && AppState.teams.length === 263 && AppState.settings.published) ? 'none' : 'block';

    const globalAnns = AppState.announcements.filter(a => a.target === 'ALL');
    document.getElementById('homeAnnouncementsArea').innerHTML = globalAnns.map(a => `<div class="alert-box alert-info mb-1"><div><strong>[${Utils.escapeHtml(a.priority)}] ${Utils.escapeHtml(a.title)}:</strong> ${Utils.escapeHtml(a.body)}</div></div>`).join('');

    LibraryModule.refreshFilters();
    if (AuthModule.isAuthenticated()) AdminUI.renderOverview();
  }
};

window.addEventListener('DOMContentLoaded', () => App.init());
  