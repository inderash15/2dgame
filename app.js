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
  normalizeMentorUsername(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.]/g, '').replace(/\.+/g, '.');
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
const LS_KEYS = { ADMIN_AUTH: 'gh_demo_admin_v3', ADMIN_SESSION: 'gh_demo_sess_v3', MENTOR_SESSION: 'gh_mentor_sess_v3', THEME: 'gh_theme_v3' };

const AppState = {
  games: [],
  teams: [],
  mentors: [],
  allocations: [],
  publishedAllocations: [],
  teamMeta: {},
  sixGameTeams: [],
  allocationVersions: [],
  teamProgress: {},
  progressHistory: [],
  announcements: [],
  auditHistory: [],
  settings: {
    platformName: 'GAMEHUB',
    institutionName: 'School of Intelligent Systems & Data Science — 2D Game Event',
    academicYear: '2026–27',
    publicPortalEnabled: true,
    apiBaseUrl: '',
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
    for (const k of ['games','teams','mentors','allocations','publishedAllocations','teamMeta','sixGameTeams','allocationVersions','teamProgress','progressHistory','announcements','auditHistory']) {
      AppState[k] = await this.get(k, AppState[k]);
    }
    const savedSettings = await this.get('settings', null);
    if (savedSettings) AppState.settings = { ...AppState.settings, ...savedSettings };
    // Normalize teamId consistently across stored teams and allocations
    AppState.teams = (AppState.teams || []).map(t => {
      const id = Utils.normalizeTeamNumber(t.teamId || t.teamNumber);
      return { ...t, teamId: id, teamNumber: id };
    });
    const normAlloc = (arr) => (arr || []).map(a => {
      const id = Utils.normalizeTeamNumber(a.teamId || a.teamNumber);
      return { ...a, teamId: id, teamNumber: id };
    });
    AppState.allocations = normAlloc(AppState.allocations);
    AppState.publishedAllocations = normAlloc(AppState.publishedAllocations);
    if (AppState.settings.published && AppState.publishedAllocations.length === 0 && AppState.allocations.length === 1750) {
      AppState.publishedAllocations = [...AppState.allocations];
    }
    this.syncMentorsFromTeams();
  },
  syncMentorsFromTeams() {
    const byUser = new Map((AppState.mentors || []).map(m => [m.username, m]));
    for (const t of AppState.teams) {
      if (!t.facultyMentor) continue;
      const username = Utils.normalizeMentorUsername(t.facultyMentor);
      if (!username || byUser.has(username)) continue;
      byUser.set(username, {
        username,
        displayName: t.facultyMentor,
        department: t.department || '',
        passwordHash: AuthModule.hashPass('pass123'),
        mustChangePassword: true,
        active: true,
        lastLoginAt: null,
        loginCount: 0
      });
    }
    AppState.mentors = Array.from(byUser.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  },
  async saveState(keys = ['games','teams','mentors','allocations','publishedAllocations','teamMeta','sixGameTeams','allocationVersions','teamProgress','progressHistory','announcements','auditHistory','settings']) {
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
    if (!localStorage.getItem(LS_KEYS.ADMIN_AUTH)) {
      localStorage.setItem(LS_KEYS.ADMIN_AUTH, JSON.stringify({ username: 'admin', hash: this.hashPass('admin103') }));
    }
    document.getElementById('adminSetupForm').style.display = 'none';
    document.getElementById('adminLoginForm').style.display = 'block';
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
  async handleLogin(e) {
    e.preventDefault();
    const u = document.getElementById('loginUsername').value.trim();
    const p = document.getElementById('loginPassword').value;
    const apiBase = (AppState.settings.apiBaseUrl || '').replace(/\/+$/, '');
    if (apiBase) {
      try {
        const res = await fetch(`${apiBase}/api/auth/login`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        if (!res.ok) { Utils.toast('Invalid admin credentials.', 'error'); return; }
        sessionStorage.setItem(LS_KEYS.ADMIN_SESSION, JSON.stringify({ authenticated: true, username: u }));
        this.syncNav(); App.navigate('admin-dashboard'); Utils.toast('Signed in via backend.', 'success');
        return;
      } catch (err) {
        Utils.toast('Backend unreachable: ' + err.message, 'error');
        return;
      }
    }
    if (!localStorage.getItem(LS_KEYS.ADMIN_AUTH)) {
      localStorage.setItem(LS_KEYS.ADMIN_AUTH, JSON.stringify({ username: 'admin', hash: this.hashPass('admin103') }));
    }
    const st = JSON.parse(localStorage.getItem(LS_KEYS.ADMIN_AUTH) || 'null');
    if (!st || st.username !== u || st.hash !== this.hashPass(p)) { Utils.toast('Invalid credentials.', 'error'); return; }
    sessionStorage.setItem(LS_KEYS.ADMIN_SESSION, JSON.stringify({ authenticated: true, username: u }));
    this.syncNav(); App.navigate('admin-dashboard');
  },
  logout() { sessionStorage.removeItem(LS_KEYS.ADMIN_SESSION); this.syncNav(); App.navigate('home'); },
  resetDemoCredentials() {
    if (!confirm('Reset local demo credentials to default?')) return;
    localStorage.setItem(LS_KEYS.ADMIN_AUTH, JSON.stringify({ username: 'admin', hash: this.hashPass('admin103') }));
    sessionStorage.removeItem(LS_KEYS.ADMIN_SESSION);
    this.renderAuthView(); this.syncNav();
    Utils.toast('Local admin reset.', 'info');
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
      const parsed = []; const seenIds = new Set();
      const duplicateIds = []; const failedRecords = []; const missingRequired = [];
      let totalRows = 0;

      const cellStr = (row, c) => {
        if (!c) return '';
        const val = row.getCell(c).value;
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') {
          if (val.richText) return val.richText.map(rt => rt.text || '').join('').trim();
          if (val.result !== undefined) return String(val.result).trim();
          if (val.text !== undefined) return String(val.text).trim();
        }
        return String(val).trim();
      };

      for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const gameId = cellStr(row, idx.gameId);
        const title = cellStr(row, idx.title);
        if (!gameId && !title) continue;
        totalRows++;

        const genre = cellStr(row, idx.genre);
        const difficulty = cellStr(row, idx.difficulty);
        if (!gameId || !title || !genre) {
          missingRequired.push(`Row ${r} (${gameId || 'no ID'})`);
          failedRecords.push({ row: r, reason: 'Missing required field (Game ID, Title, or Genre)' });
          continue;
        }
        if (seenIds.has(gameId)) {
          duplicateIds.push(gameId);
          continue;
        }
        seenIds.add(gameId);
        parsed.push({
          gameId, sourceTeamId: cellStr(row, idx.sourceTeamId), gameSlot: cellStr(row, idx.gameSlot),
          genre: genre || 'Uncategorized', title, coreMechanic: cellStr(row, idx.coreMechanic),
          description: cellStr(row, idx.description), objective: cellStr(row, idx.objective),
          level1Focus: cellStr(row, idx.level1Focus), level2Focus: cellStr(row, idx.level2Focus),
          implementation2D: cellStr(row, idx.implementation2D), scope12Hour: cellStr(row, idx.scope12Hour),
          difficulty: difficulty || 'Medium', conceptOrigin: cellStr(row, idx.conceptOrigin),
          originalRef: cellStr(row, idx.originalRef), uniquenessCheck: cellStr(row, idx.uniquenessCheck), archived: false
        });
      }
      const importTime = new Date().toLocaleString();
      AppState.pendingExcelGames = parsed;
      AppState.pendingExcelStats = { totalRows, validCount: parsed.length, failedCount: failedRecords.length, duplicateCount: duplicateIds.length, missingCount: missingRequired.length, importTime };
      const ok = parsed.length === 1750 && duplicateIds.length === 0 && failedRecords.length === 0;
      el.innerHTML = `
        <div class="alert-box ${ok ? 'alert-success' : 'alert-warn'} mb-2">
          <div>
            <strong>Excel Import Validation (${Utils.escapeHtml(sheet.name)}):</strong><br/>
            Total records in Excel: <strong>${totalRows}</strong> |
            Valid unique games: <strong>${parsed.length} / 1,750</strong> |
            Failed records: <strong>${failedRecords.length}</strong> |
            Duplicate Game IDs: <strong>${duplicateIds.length}</strong> |
            Missing required fields: <strong>${missingRequired.length}</strong><br/>
            <span class="text-xs">Parsed at: ${Utils.escapeHtml(importTime)} (Historical Team ID column preserved as source metadata only)</span>
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="ExcelModule.confirmImport()">Confirm & Import ${parsed.length} Games</button>
      `;
    } catch (err) {
      el.innerHTML = `<div class="alert-box alert-danger">${Utils.escapeHtml(err.message)}</div>`;
    }
  },
  async confirmImport() {
    if (!AppState.pendingExcelGames) return;
    if (AppState.settings.locked && !confirm('Allocation is LOCKED. Replacing games will unlock and reset draft allocations. Continue?')) return;
    const apiBase = (AppState.settings.apiBaseUrl || '').replace(/\/+$/, '');
    if (apiBase) {
      try {
        const res = await fetch(`${apiBase}/api/admin/import/games`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ games: AppState.pendingExcelGames })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Backend import failed (${res.status})`);
        }
      } catch (err) {
        document.getElementById('excelPreviewArea').innerHTML = `<div class="alert-box alert-danger">Import failed: ${Utils.escapeHtml(err.message)}</div>`;
        Utils.toast(err.message, 'error');
        return;
      }
    }
    const stats = AppState.pendingExcelStats || { totalRows: AppState.pendingExcelGames.length, validCount: AppState.pendingExcelGames.length, failedCount: 0, duplicateCount: 0, missingCount: 0, importTime: new Date().toLocaleString() };
    AppState.games = AppState.pendingExcelGames;
    AppState.pendingExcelGames = null;
    AppState.allocations = []; AppState.settings.locked = false;
    await DataRepository.saveState(['games','allocations','settings']);
    await DataRepository.logAudit('EXCEL_IMPORT', `Imported ${AppState.games.length} games (${stats.duplicateCount} dupes, ${stats.failedCount} failed).`);
    document.getElementById('excelPreviewArea').innerHTML = `
      <div class="alert-box alert-success">
        <div>
          <strong>Import Complete (${Utils.escapeHtml(stats.importTime)}):</strong>
          Total in Excel: <strong>${stats.totalRows}</strong> |
          Successfully imported: <strong>${AppState.games.length}</strong> |
          Failed: <strong>${stats.failedCount}</strong> |
          Duplicates skipped: <strong>${stats.duplicateCount}</strong> |
          Missing fields: <strong>${stats.missingCount}</strong>
        </div>
      </div>`;
    App.refreshAllUI();
  }
};

const PdfRosterModule = {
  async handleFileSelect(e) {
    const f = e.target.files[0]; if (!f) return;
    await this.processArrayBuffer(await f.arrayBuffer(), f.name);
    e.target.value = '';
  },
  async extractFromArrayBuffer(buf) {
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const teamMap = new Map();
    const duplicateRecords = [];
    const failedRecords = [];
    let totalExtracted = 0;
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
        const tMatch = joined.match(/\b(T\d{3})\b/i);
        if (!tMatch) continue;

        totalExtracted++;
        const row = this.bin(l.items, anchors);
        const teamId = Utils.normalizeTeamNumber(tMatch[1]);
        const leaderName = (row.teamLeader || '').trim();

        if (!/^T\d{3}$/.test(teamId) || !leaderName) {
          failedRecords.push({ line: joined, reason: 'Missing Team ID or Team Leader' });
          continue;
        }

        let mentor = (row.facultyMentor || '').trim();
        let mentorMobile = (row.mentorMobile || '').trim();
        if (!mentor && lastMentor) { mentor = lastMentor; mentorMobile = mentorMobile || lastMentorMobile; }
        else if (mentor) { lastMentor = mentor; lastMentorMobile = mentorMobile; }

        if (teamMap.has(teamId)) {
          duplicateRecords.push(teamId);
          continue;
        }

        teamMap.set(teamId, {
          sno: row.sno || '', department: row.department || '', classSheet: row.classSheet || '',
          teamId, teamNumber: teamId, leaderName, registerNumber: row.registerNo || '',
          leaderClass: row.leaderClass || '', leaderContact: row.leaderContact || '-',
          facultyMentor: mentor, mentorMobile: mentorMobile || '-', accessCode: ''
        });
      }
    }

    const teams = Array.from(teamMap.values()).sort((a, b) => a.teamId.localeCompare(b.teamId));
    const expected = Array.from({ length: 263 }, (_, i) => 'T' + String(i + 1).padStart(3, '0'));
    const missingTeamIds = expected.filter(id => !teamMap.has(id));

    return {
      teams,
      stats: {
        totalExtracted,
        importedCount: teams.length,
        failedCount: failedRecords.length,
        duplicateCount: duplicateRecords.length,
        missingTeamIds,
        failedRecords
      }
    };
  },
  async processArrayBuffer(buf, filename) {
    const el = document.getElementById('pdfVerificationArea');
    el.innerHTML = `<div class="alert-box alert-info">Parsing ${Utils.escapeHtml(filename)}...</div>`;
    try {
      const { teams, stats } = await this.extractFromArrayBuffer(buf);
      AppState.pendingPdfTeams = teams;
      const ok = stats.importedCount === 263 && stats.missingTeamIds.length === 0 && stats.failedCount === 0;
      el.innerHTML = `
        <div class="alert-box ${ok ? 'alert-success' : 'alert-warn'} mb-2">
          <div>
            <strong>PDF Extraction Statistics:</strong><br/>
            Total extracted: <strong>${stats.totalExtracted}</strong> |
            Valid unique teams: <strong>${stats.importedCount} / 263</strong> |
            Duplicates skipped: <strong>${stats.duplicateCount}</strong> |
            Failed records: <strong>${stats.failedCount}</strong> |
            Missing Team IDs: <strong>${stats.missingTeamIds.length === 0 ? 'None' : stats.missingTeamIds.join(', ')}</strong>
          </div>
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
      let bestDist = Infinity;
      for (const [k, ax] of cols) {
        const dist = Math.abs(it.x - ax);
        if (dist < bestDist) { bestDist = dist; bk = k; }
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
  async lookupTeam(raw) {
    const area = document.getElementById('lookupResultArea');
    if (!AppState.settings.publicPortalEnabled) {
      area.innerHTML = `<div class="alert-box alert-warn">Team Leader Portal is currently disabled by the Administrator.</div>`; return;
    }
    const teamId = Utils.normalizeTeamNumber(raw);
    if (!/^T(00[1-9]|0[1-9]\d|1\d\d|2[0-5]\d|26[0-3])$/.test(teamId)) {
      area.innerHTML = `<div class="alert-box alert-danger">Invalid Team ID <strong>${Utils.escapeHtml(teamId || raw)}</strong>. Please enter a valid Team ID from T001 to T263.</div>`; return;
    }

    let team = null;
    let assigned = [];
    let isPub = AppState.settings.published;
    let anns = [];
    const apiBase = (AppState.settings.apiBaseUrl || '').replace(/\/+$/, '');

    // 1. Try Backend API if configured
    if (apiBase) {
      try {
        area.innerHTML = `<div class="alert-box alert-info">Fetching ${Utils.escapeHtml(teamId)} from backend API...</div>`;
        const res = await fetch(`${apiBase}/api/portal/team/${encodeURIComponent(teamId)}`);
        if (res.status === 404) {
          area.innerHTML = `<div class="alert-box alert-danger">Team <strong>${Utils.escapeHtml(teamId)}</strong> not found in roster.</div>`; return;
        }
        if (res.ok) {
          const data = await res.json();
          team = data.team;
          isPub = Boolean(data.published);
          assigned = data.games || [];
          anns = data.announcements || [];
        }
      } catch (err) {
        console.warn('Backend lookup fallback to local/static roster:', err.message);
      }
    }

    // 2. Local/Static fallback: auto-hydrate roster from deployed PDF if IndexedDB is empty
    if (!team) {
      if ((AppState.teams.length === 0 || (!AppState.settings.published && AppState.publishedAllocations.length === 0)) && window.location.protocol.startsWith('http')) {
        area.innerHTML = `<div class="alert-box alert-info">Loading official 263-team roster...</div>`;
        await App.autoHydrateRoster();
      }
      team = AppState.teams.find(t => (t.teamId || t.teamNumber) === teamId);
      if (!team) {
        area.innerHTML = `<div class="alert-box alert-danger">Team <strong>${Utils.escapeHtml(teamId)}</strong> not found in roster.</div>`; return;
      }
      const code = document.getElementById('lookupAccessCode')?.value || '';
      if (team.accessCode && code !== team.accessCode) {
        area.innerHTML = `<div class="alert-box alert-danger">Invalid Team Access Code for ${Utils.escapeHtml(teamId)}.</div>`; return;
      }
      const gameMap = new Map(AppState.games.map(g => [g.gameId, g]));
      const pubList = AppState.publishedAllocations.length === 1750 ? AppState.publishedAllocations : (isPub ? AppState.allocations : []);
      assigned = isPub ? pubList.filter(a => (a.teamId || a.teamNumber) === teamId).map(a => gameMap.get(a.gameId)).filter(Boolean) : [];
      anns = AppState.announcements.filter(a => a.target === 'ALL' || a.target === teamId);
    }

    this.currentTeam = team; this.currentGames = assigned;
    const displayId = team.teamId || team.teamNumber;
    const prog = AppState.teamProgress[displayId] || { status: team.progressStatus || 'Not Started', pct: team.completionPct || 0, remarks: '', updatedAt: team.lastProgressUpdate || '' };
    const progHistory = (AppState.progressHistory || []).filter(h => h.teamId === displayId);
    const cats = [...new Set(assigned.map(g => g.genre))].sort();

    area.innerHTML = `
      ${anns.length ? `<div class="mb-2">${anns.map(a => `<div class="alert-box alert-info mb-1"><div><strong>[${Utils.escapeHtml(a.priority)}] ${Utils.escapeHtml(a.title)}:</strong> ${Utils.escapeHtml(a.body)}</div></div>`).join('')}</div>` : ''}
      <div class="surface-card mb-3" style="padding:1.4rem;">
        <div class="flex-between mb-2">
          <div class="flex-center">
            <span class="badge badge-purple">${Utils.escapeHtml(displayId)}</span>
            <span class="badge ${isPub ? 'badge-green' : 'badge-amber'}">${isPub ? 'Published (' + assigned.length + ' Games)' : 'Pending Publication'}</span>
            <span class="badge badge-cyan">Progress: ${Utils.escapeHtml(prog.status)} (${prog.pct || 0}%)</span>
          </div>
          <div class="flex-center no-print">
            <button class="btn btn-secondary btn-sm" onclick="ExportModule.exportTeamPDF('${Utils.escapeHtml(displayId)}')"><i data-lucide="file-down" width="15"></i> Download Team PDF</button>
            <button class="btn btn-secondary btn-sm" onclick="window.print()"><i data-lucide="printer" width="15"></i> Print</button>
          </div>
        </div>
        <div class="grid-3">
          <div><div class="text-xs text-muted">TEAM ID</div><strong>${Utils.escapeHtml(displayId)}</strong></div>
          <div><div class="text-xs text-muted">TEAM LEADER</div><strong>${Utils.escapeHtml(team.leaderName)}</strong></div>
          <div><div class="text-xs text-muted">DEPARTMENT</div><strong>${Utils.escapeHtml(team.department)}</strong></div>
          <div><div class="text-xs text-muted">CLASS</div><strong>${Utils.escapeHtml(team.leaderClass || team.classSheet)}</strong></div>
          <div><div class="text-xs text-muted">FACULTY MENTOR</div><strong>${Utils.escapeHtml(team.facultyMentor)}</strong></div>
          <div><div class="text-xs text-muted">TOTAL ASSIGNED GAMES</div><strong>${assigned.length}</strong></div>
        </div>
        ${progHistory.length ? `
          <div class="mt-2" style="padding-top:0.85rem; border-top:1px solid var(--border-subtle);">
            <div class="text-xs text-muted mb-1"><strong>MENTOR PROGRESS UPDATES (READ-ONLY)</strong></div>
            ${progHistory.slice(0, 3).map(h => `<div class="text-xs text-muted">• <strong>${Utils.escapeHtml(h.newStatus)} (${h.newPct}%)</strong> — ${Utils.escapeHtml(h.remarks || 'No remarks')} <em>(${new Date(h.updatedAt).toLocaleString()})</em></div>`).join('')}
          </div>` : ''}
      </div>
      ${!isPub ? `<div class="alert-box alert-warn">Roster verified for <strong>${Utils.escapeHtml(displayId)}</strong>. Game allocations are currently in Draft mode and have not been published by the Administrator yet.</div>` : `
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
    if (tab === 'mentors') MentorAdminModule.render();
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
    const pubG = AppState.settings.published ? (AppState.publishedAllocations.length || allocG) : 0;
    const pendG = AppState.settings.published ? 0 : allocG;

    document.getElementById('kpiTotalGames').textContent = totalG;
    document.getElementById('kpiTotalTeams').textContent = AppState.teams.length;
    document.getElementById('kpiTotalMentors').textContent = AppState.mentors.length;
    document.getElementById('kpiAssignedGames').textContent = allocG;
    document.getElementById('kpiUnassignedGames').textContent = Math.max(0, totalG - allocG);
    document.getElementById('kpiPublishedCount').textContent = pubG;
    document.getElementById('kpiPendingCount').textContent = pendG;

    let ns = 0, ip = 0, cp = 0;
    AppState.teams.forEach(t => {
      const st = (AppState.teamProgress[t.teamNumber]?.status || 'Not Started');
      if (st === 'Not Started') ns++;
      else if (st === 'Completed' || st === 'Submitted') cp++;
      else ip++;
    });
    document.getElementById('kpiProgNotStarted').textContent = ns;
    document.getElementById('kpiProgInProgress').textContent = ip;
    document.getElementById('kpiProgCompleted').textContent = cp;
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
    mk('chartGenre', 'bar', topG.map(x => x[0]), topG.map(x => x[1]), '#D4A64A');

    const diffs = { Easy: 0, Medium: 0, Hard: 0 }; AppState.games.forEach(g => { diffs[g.difficulty] = (diffs[g.difficulty] || 0) + 1; });
    mk('chartDifficulty', 'doughnut', Object.keys(diffs), Object.values(diffs), ['#059669', '#D4A64A', '#B98532']);

    mk('chartAllocDist', 'doughnut', ['7-Game Teams', '6-Game Teams'], [val.t7, val.t6], ['#D4A64A', '#24262B']);

    const mTeams = {}; AppState.teams.forEach(t => { const m = t.facultyMentor || 'Unassigned'; mTeams[m] = (mTeams[m] || 0) + 1; });
    const topM = Object.entries(mTeams).sort((a, b) => b[1] - a[1]);
    mk('chartMentorTeams', 'bar', topM.map(x => x[0]), topM.map(x => x[1]), '#F0B44D');

    mk('chartStudentProgress', 'doughnut', ['Not Started', 'In Progress', 'Completed'], [ns, ip, cp], ['#777777', '#F0B44D', '#059669']);

    const dTeams = {}; AppState.teams.forEach(t => { dTeams[t.department] = (dTeams[t.department] || 0) + 1; });
    mk('chartDeptTeams', 'bar', Object.keys(dTeams), Object.values(dTeams), '#B98532');
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

    const q = (document.getElementById('adminGameSearch').value || '').toLowerCase().trim();
    const diff = document.getElementById('adminGameDiffFilter').value;
    const arch = document.getElementById('adminGameArchiveFilter').value;
    const allocMap = new Map(AppState.allocations.map(a => [a.gameId, a.teamId || a.teamNumber]));

    const list = AppState.games.filter(g => {
      if (arch === 'active' && g.archived) return false;
      if (arch === 'archived' && !g.archived) return false;
      if (q && !g.gameId.toLowerCase().includes(q) && !g.title.toLowerCase().includes(q) && !(g.coreMechanic || '').toLowerCase().includes(q)) return false;
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
    AppState.settings.locked = false;
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
      await DataRepository.logAudit('ALLOC_GENERATE', `Generated Draft ${ver} with seed ${seed}.`);
      this.render(); App.refreshAllUI(); Utils.toast(`Generated Draft ${ver}. Validate and click Approve & Publish when ready.`, 'success');
    } catch (err) { Utils.toast(err.message, 'error'); }
  },
  async approveAndPublish() {
    const val = ValidationEngine.validateAll();
    if (!val.allPassed) { Utils.toast('Cannot publish: fix validation failures first.', 'error'); return; }
    AppState.publishedAllocations = JSON.parse(JSON.stringify(AppState.allocations));
    AppState.settings.published = true;
    if (AppState.allocationVersions[0]) AppState.allocationVersions[0].status = 'Published';
    await DataRepository.saveState(['publishedAllocations','settings','allocationVersions']);
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

const MentorAdminModule = {
  render() {
    DataRepository.syncMentorsFromTeams();
    const q = (document.getElementById('adminMentorSearch')?.value || '').toLowerCase();
    const list = AppState.mentors.filter(m => !q || m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q));
    document.getElementById('adminMentorsTbody').innerHTML = list.map(m => {
      const myTeams = AppState.teams.filter(t => t.facultyMentor === m.displayName);
      const comp = myTeams.filter(t => ['Completed','Submitted'].includes(AppState.teamProgress[t.teamId]?.status)).length;
      const inProg = myTeams.filter(t => ['Planning','Development In Progress','Testing'].includes(AppState.teamProgress[t.teamId]?.status)).length;
      return `<tr>
        <td><strong>${Utils.escapeHtml(m.displayName)}</strong></td>
        <td class="mono text-xs">${Utils.escapeHtml(m.username)}</td>
        <td><button class="btn btn-secondary btn-sm" onclick="MentorAdminModule.viewTeams('${Utils.escapeHtml(m.displayName)}')">${myTeams.length} Teams</button></td>
        <td class="text-xs">${comp} Completed · ${inProg} In Progress</td>
        <td><span class="badge ${m.active ? 'badge-green' : 'badge-rose'}">${m.active ? 'Active' : 'Inactive'}</span></td>
        <td class="text-xs text-muted">${m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : 'Never'} (${m.loginCount || 0})</td>
        <td class="flex-center">
          <button class="btn btn-secondary btn-sm" onclick="MentorAdminModule.toggleActive('${Utils.escapeHtml(m.username)}')">${m.active ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-warning btn-sm" onclick="MentorAdminModule.resetPass('${Utils.escapeHtml(m.username)}')">Reset Pass</button>
        </td>
      </tr>`;
    }).join('') || `<tr><td colspan="7" class="text-muted">No mentors found.</td></tr>`;
  },
  viewTeams(mentorName) {
    const myTeams = AppState.teams.filter(t => t.facultyMentor === mentorName);
    ModalUI.openCustom(`Teams Assigned to ${mentorName}`, `
      <div class="table-wrap"><table><thead><tr><th>Team ID</th><th>Leader</th><th>Dept</th><th>Status</th></tr></thead>
      <tbody>${myTeams.map(t => `<tr><td class="mono">${Utils.escapeHtml(t.teamId)}</td><td>${Utils.escapeHtml(t.leaderName)}</td><td>${Utils.escapeHtml(t.department)}</td><td>${Utils.escapeHtml(AppState.teamProgress[t.teamId]?.status || 'Not Started')}</td></tr>`).join('')}</tbody></table></div>`);
  },
  openCreateModal() {
    ModalUI.openCustom('Create Faculty Mentor Account', `
      <form onsubmit="MentorAdminModule.create(event)">
        <div class="form-group"><label class="form-label">Faculty Mentor Full Name</label><input id="newMentorName" class="form-control" placeholder="e.g., Dr. S. Kumar" required /></div>
        <div class="form-group"><label class="form-label">Department</label><input id="newMentorDept" class="form-control" placeholder="e.g., AIDS" /></div>
        <button type="submit" class="btn btn-primary">Create Mentor (Initial Password: pass123)</button>
      </form>`);
  },
  async create(e) {
    e.preventDefault();
    const displayName = document.getElementById('newMentorName').value.trim();
    const department = document.getElementById('newMentorDept').value.trim();
    const username = Utils.normalizeMentorUsername(displayName);
    if (AppState.mentors.some(m => m.username === username)) { Utils.toast('Mentor username already exists.', 'warn'); return; }
    AppState.mentors.push({ username, displayName, department, passwordHash: AuthModule.hashPass('pass123'), mustChangePassword: true, active: true, lastLoginAt: null, loginCount: 0 });
    await DataRepository.saveState(['mentors']);
    await DataRepository.logAudit('MENTOR_CREATE', `Created mentor ${username}`);
    ModalUI.close(); this.render(); Utils.toast(`Created ${username} (pass123)`, 'success');
  },
  async toggleActive(username) {
    const m = AppState.mentors.find(x => x.username === username); if (!m) return;
    m.active = !m.active;
    await DataRepository.saveState(['mentors']);
    await DataRepository.logAudit('MENTOR_STATUS', `${m.active ? 'Activated' : 'Deactivated'} ${username}`);
    this.render();
  },
  async resetPass(username) {
    const m = AppState.mentors.find(x => x.username === username); if (!m) return;
    m.passwordHash = AuthModule.hashPass('pass123');
    m.mustChangePassword = true;
    await DataRepository.saveState(['mentors']);
    await DataRepository.logAudit('MENTOR_PASS_RESET', `Reset password for ${username} to pass123`);
    Utils.toast(`Reset ${username} password to pass123 (forced change on next login).`, 'success');
  },
  openReassignModal() {
    ModalUI.openCustom('Reassign Team to Faculty Mentor', `
      <form onsubmit="MentorAdminModule.reassign(event)">
        <div class="form-group"><label class="form-label">Team ID</label><input id="reasTeamId" class="form-control" placeholder="e.g., T001" required /></div>
        <div class="form-group"><label class="form-label">Target Faculty Mentor</label>
          <select id="reasMentorName" class="form-control">${AppState.mentors.map(m => `<option value="${Utils.escapeHtml(m.displayName)}">${Utils.escapeHtml(m.displayName)}</option>`).join('')}</select>
        </div>
        <button type="submit" class="btn btn-primary">Reassign Team</button>
      </form>`);
  },
  async reassign(e) {
    e.preventDefault();
    const tid = Utils.normalizeTeamNumber(document.getElementById('reasTeamId').value);
    const mentor = document.getElementById('reasMentorName').value;
    const t = AppState.teams.find(x => x.teamId === tid);
    if (!t) { Utils.toast('Team not found.', 'error'); return; }
    t.facultyMentor = mentor;
    await DataRepository.saveState(['teams']);
    await DataRepository.logAudit('MENTOR_REASSIGN', `Reassigned ${tid} to ${mentor}`);
    ModalUI.close(); this.render(); Utils.toast(`Reassigned ${tid} to ${mentor}`, 'success');
  }
};

const ProgressModule = {
  render() {
    const mentors = [...new Set(AppState.teams.map(t => t.facultyMentor).filter(Boolean))].sort();
    const depts = [...new Set(AppState.teams.map(t => t.department).filter(Boolean))].sort();
    const mSel = document.getElementById('progressMentorFilter'); const curM = mSel?.value || '';
    if (mSel) { mSel.innerHTML = `<option value="">All Mentors</option>` + mentors.map(m=>`<option value="${Utils.escapeHtml(m)}">${Utils.escapeHtml(m)}</option>`).join(''); mSel.value = curM; }
    const dSel = document.getElementById('progressDeptFilter'); const curD = dSel?.value || '';
    if (dSel) { dSel.innerHTML = `<option value="">All Departments</option>` + depts.map(d=>`<option value="${Utils.escapeHtml(d)}">${Utils.escapeHtml(d)}</option>`).join(''); dSel.value = curD; }

    const q = (document.getElementById('progressSearch')?.value || '').toLowerCase();
    const sf = document.getElementById('progressStatusFilter')?.value || '';
    const statuses = ['Not Started','Planning','Development In Progress','Testing','Completed','Submitted'];
    const counts = {};
    (AppState.publishedAllocations.length ? AppState.publishedAllocations : AppState.allocations).forEach(a => { counts[a.teamId || a.teamNumber] = (counts[a.teamId || a.teamNumber] || 0) + 1; });

    const list = AppState.teams.filter(t => {
      const p = AppState.teamProgress[t.teamId] || { status: 'Not Started', pct: 0 };
      if (q && !t.teamId.toLowerCase().includes(q) && !t.leaderName.toLowerCase().includes(q)) return false;
      if (curM && t.facultyMentor !== curM) return false;
      if (curD && t.department !== curD) return false;
      if (sf && p.status !== sf) return false;
      return true;
    });

    document.getElementById('progressTbody').innerHTML = list.slice(0, 80).map(t => {
      const p = AppState.teamProgress[t.teamId] || { status: 'Not Started', pct: 0, updatedAt: '' };
      return `<tr>
        <td class="mono"><strong>${Utils.escapeHtml(t.teamId)}</strong></td>
        <td>${Utils.escapeHtml(t.leaderName)}</td>
        <td class="text-xs">${Utils.escapeHtml(t.facultyMentor)}</td>
        <td>${Utils.escapeHtml(t.department)}</td>
        <td class="mono">${counts[t.teamId] || 0}</td>
        <td><select id="progSt_${t.teamId}" class="form-control">${statuses.map(s=>`<option ${p.status===s?'selected':''}>${s}</option>`).join('')}</select></td>
        <td><input id="progPct_${t.teamId}" type="number" min="0" max="100" class="form-control" style="width:74px;" value="${p.pct || 0}" /></td>
        <td class="text-xs text-muted">${p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '—'}</td>
        <td><button class="btn btn-secondary btn-sm" onclick="ProgressModule.save('${t.teamId}')">Save</button></td>
      </tr>`;
    }).join('') || `<tr><td colspan="9" class="text-muted">No teams match filters.</td></tr>`;
  },
  async save(tNo) {
    const prev = AppState.teamProgress[tNo] || { status: 'Not Started', pct: 0 };
    const newStatus = document.getElementById(`progSt_${tNo}`).value;
    const newPct = Math.min(100, Math.max(0, Number(document.getElementById(`progPct_${tNo}`).value) || 0));
    const now = new Date().toISOString();
    AppState.teamProgress[tNo] = { status: newStatus, pct: newPct, remarks: prev.remarks || '', updatedAt: now };
    AppState.progressHistory.unshift({ teamId: tNo, mentorId: 'Admin', previousStatus: prev.status, newStatus, previousPct: prev.pct || 0, newPct, remarks: 'Updated by Admin', updatedAt: now });
    await DataRepository.saveState(['teamProgress', 'progressHistory']);
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
    const apiEl = document.getElementById('setApiBaseUrl');
    if (apiEl) apiEl.value = AppState.settings.apiBaseUrl || '';
  },
  async save(e) {
    e.preventDefault();
    AppState.settings.platformName = document.getElementById('setPlatformName').value.trim();
    AppState.settings.institutionName = document.getElementById('setInstName').value.trim();
    AppState.settings.academicYear = document.getElementById('setAcadYear').value.trim();
    AppState.settings.publicPortalEnabled = document.getElementById('setPublicPortal').value === 'true';
    const apiEl = document.getElementById('setApiBaseUrl');
    if (apiEl) AppState.settings.apiBaseUrl = apiEl.value.trim().replace(/\/+$/, '');
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
const MentorPortal = {
  getSession() {
    try { return JSON.parse(sessionStorage.getItem(LS_KEYS.MENTOR_SESSION) || 'null'); } catch { return null; }
  },
  isAuthenticated() {
    const s = this.getSession();
    return Boolean(s && s.authenticated && !s.mustChangePassword);
  },
  syncNav() {
    const ok = this.isAuthenticated();
    const b1 = document.getElementById('navMentorBtn'), b2 = document.getElementById('navMentorDashBtn');
    if (b1) b1.style.display = ok ? 'none' : 'inline-flex';
    if (b2) b2.style.display = ok ? 'inline-flex' : 'none';
  },
  async handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('mentorUsername').value.trim().toLowerCase();
    const password = document.getElementById('mentorPassword').value;
    if (AppState.teams.length === 0 && window.location.protocol.startsWith('http')) await App.autoHydrateRoster();
    DataRepository.syncMentorsFromTeams();

    const mentor = AppState.mentors.find(m => m.username === username);
    if (!mentor || !mentor.active || mentor.passwordHash !== AuthModule.hashPass(password)) {
      Utils.toast('Invalid mentor username/password or inactive account.', 'error');
      return;
    }
    mentor.lastLoginAt = new Date().toISOString();
    mentor.loginCount = (mentor.loginCount || 0) + 1;
    await DataRepository.saveState(['mentors']);

    sessionStorage.setItem(LS_KEYS.MENTOR_SESSION, JSON.stringify({
      authenticated: true, username: mentor.username, displayName: mentor.displayName, mustChangePassword: Boolean(mentor.mustChangePassword)
    }));
    if (mentor.mustChangePassword) {
      document.getElementById('mentorLoginBox').style.display = 'none';
      document.getElementById('mentorForceChangeBox').style.display = 'block';
      Utils.toast('Temporary password detected. Please set a new password.', 'warn');
      return;
    }
    this.syncNav(); App.navigate('mentor-dashboard'); Utils.toast(`Welcome, ${mentor.displayName}`, 'success');
  },
  async handleForcePasswordChange(e) {
    e.preventDefault();
    const p1 = document.getElementById('mentorNewPass').value;
    const p2 = document.getElementById('mentorConfirmPass').value;
    if (p1 !== p2) { Utils.toast('Passwords do not match.', 'error'); return; }
    const s = this.getSession(); if (!s) return;
    const m = AppState.mentors.find(x => x.username === s.username);
    if (m) { m.passwordHash = AuthModule.hashPass(p1); m.mustChangePassword = false; await DataRepository.saveState(['mentors']); }
    s.mustChangePassword = false;
    sessionStorage.setItem(LS_KEYS.MENTOR_SESSION, JSON.stringify(s));
    document.getElementById('mentorForceChangeBox').style.display = 'none';
    document.getElementById('mentorLoginBox').style.display = 'block';
    this.syncNav(); App.navigate('mentor-dashboard'); Utils.toast('Password updated! Welcome to Mentor Portal.', 'success');
  },
  openChangePasswordModal() {
    ModalUI.openCustom('Change Mentor Password', `
      <form onsubmit="MentorPortal.changePassword(event)">
        <div class="form-group"><label class="form-label">Current Password</label><input type="password" id="mCurP" class="form-control" autocomplete="current-password" required /></div>
        <div class="form-group"><label class="form-label">New Password (min 6 chars)</label><input type="password" id="mNewP" class="form-control" autocomplete="new-password" minlength="6" required /></div>
        <button type="submit" class="btn btn-primary">Update Password</button>
      </form>`);
  },
  async changePassword(e) {
    e.preventDefault();
    const s = this.getSession(); if (!s) return;
    const m = AppState.mentors.find(x => x.username === s.username);
    if (!m || m.passwordHash !== AuthModule.hashPass(document.getElementById('mCurP').value)) { Utils.toast('Current password incorrect.', 'error'); return; }
    m.passwordHash = AuthModule.hashPass(document.getElementById('mNewP').value);
    m.mustChangePassword = false;
    await DataRepository.saveState(['mentors']); ModalUI.close(); Utils.toast('Password updated.', 'success');
  },
  logout() {
    sessionStorage.removeItem(LS_KEYS.MENTOR_SESSION);
    this.syncNav(); App.navigate('home');
  },
  getMyTeams() {
    const s = this.getSession(); if (!s) return [];
    return AppState.teams.filter(t => t.facultyMentor === s.displayName);
  },
  renderDashboard() {
    const s = this.getSession(); if (!s) return;
    document.getElementById('mentorWelcomeTitle').textContent = `Welcome, ${s.displayName}`;
    const myTeams = this.getMyTeams();
    const depts = [...new Set(myTeams.map(t => t.department))].sort();
    const dSel = document.getElementById('mentorDeptFilter'); const curD = dSel.value;
    dSel.innerHTML = `<option value="">All Departments</option>` + depts.map(d => `<option value="${Utils.escapeHtml(d)}">${Utils.escapeHtml(d)}</option>`).join('');
    dSel.value = curD;

    const allocList = AppState.publishedAllocations.length ? AppState.publishedAllocations : AppState.allocations;
    const myTeamIds = new Set(myTeams.map(t => t.teamId));
    const myGamesCount = allocList.filter(a => myTeamIds.has(a.teamId || a.teamNumber)).length;
    let ns = 0, ip = 0, cp = 0;
    myTeams.forEach(t => {
      const st = AppState.teamProgress[t.teamId]?.status || 'Not Started';
      if (st === 'Not Started') ns++; else if (st === 'Completed' || st === 'Submitted') cp++; else ip++;
    });
    document.getElementById('mKpiTeams').textContent = myTeams.length;
    document.getElementById('mKpiStudents').textContent = myTeams.length;
    document.getElementById('mKpiGames').textContent = myGamesCount;
    document.getElementById('mKpiNotStarted').textContent = ns;
    document.getElementById('mKpiInProgress').textContent = ip;
    document.getElementById('mKpiCompleted').textContent = cp;
    this.renderTeams();
  },
  renderTeams() {
    const q = (document.getElementById('mentorSearchInput')?.value || '').toLowerCase();
    const df = document.getElementById('mentorDeptFilter')?.value || '';
    const sf = document.getElementById('mentorStatusFilter')?.value || '';
    const sort = document.getElementById('mentorSortSelect')?.value || 'id';
    const allocList = AppState.publishedAllocations.length ? AppState.publishedAllocations : AppState.allocations;
    const counts = {}; allocList.forEach(a => { const tid = a.teamId || a.teamNumber; counts[tid] = (counts[tid] || 0) + 1; });

    let list = this.getMyTeams().filter(t => {
      const st = AppState.teamProgress[t.teamId]?.status || 'Not Started';
      if (q && !t.teamId.toLowerCase().includes(q) && !t.leaderName.toLowerCase().includes(q)) return false;
      if (df && t.department !== df) return false;
      if (sf && st !== sf) return false;
      return true;
    });
    if (sort === 'prog_desc') list.sort((a, b) => (AppState.teamProgress[b.teamId]?.pct || 0) - (AppState.teamProgress[a.teamId]?.pct || 0));
    else if (sort === 'prog_asc') list.sort((a, b) => (AppState.teamProgress[a.teamId]?.pct || 0) - (AppState.teamProgress[b.teamId]?.pct || 0));
    else list.sort((a, b) => a.teamId.localeCompare(b.teamId));

    document.getElementById('mentorTeamsTbody').innerHTML = list.map(t => {
      const p = AppState.teamProgress[t.teamId] || { status: 'Not Started', pct: 0 };
      return `<tr>
        <td class="mono"><strong>${Utils.escapeHtml(t.teamId)}</strong></td>
        <td>${Utils.escapeHtml(t.leaderName)}</td>
        <td>${Utils.escapeHtml(t.department)}</td>
        <td class="text-xs">${Utils.escapeHtml(t.leaderClass || t.classSheet)}</td>
        <td class="mono text-xs">${Utils.escapeHtml(t.registerNumber)}</td>
        <td class="mono">${counts[t.teamId] || 0}</td>
        <td><span class="badge badge-blue">${Utils.escapeHtml(p.status)}</span></td>
        <td class="mono">${p.pct || 0}%</td>
        <td><button class="btn btn-primary btn-sm" onclick="MentorPortal.openTeamDetails('${Utils.escapeHtml(t.teamId)}')">Manage & Games</button></td>
      </tr>`;
    }).join('') || `<tr><td colspan="9" class="text-muted">No assigned teams match filters.</td></tr>`;
  },
  openTeamDetails(teamId) {
    const s = this.getSession(); if (!s) return;
    const team = AppState.teams.find(t => t.teamId === teamId);
    if (!team || team.facultyMentor !== s.displayName) { Utils.toast('Forbidden: You cannot access another mentor\'s team.', 'error'); return; }
    const gMap = new Map(AppState.games.map(g => [g.gameId, g]));
    const allocList = AppState.publishedAllocations.length ? AppState.publishedAllocations : AppState.allocations;
    const games = allocList.filter(a => (a.teamId || a.teamNumber) === teamId).map(a => gMap.get(a.gameId)).filter(Boolean);
    const p = AppState.teamProgress[teamId] || { status: 'Not Started', pct: 0, remarks: '', updatedAt: '' };
    const hist = (AppState.progressHistory || []).filter(h => h.teamId === teamId);
    const statuses = ['Not Started','Planning','Development In Progress','Testing','Completed','Submitted'];

    ModalUI.openCustom(`Team ${teamId} — ${team.leaderName}`, `
      <div class="grid-3 mb-2" style="padding:0.8rem; background:var(--bg-elevated); border-radius:10px;">
        <div><div class="text-xs text-muted">TEAM ID</div><strong>${Utils.escapeHtml(team.teamId)}</strong></div>
        <div><div class="text-xs text-muted">DEPARTMENT / CLASS</div><strong>${Utils.escapeHtml(team.department)} (${Utils.escapeHtml(team.leaderClass || team.classSheet)})</strong></div>
        <div><div class="text-xs text-muted">REGISTER NO</div><strong class="mono">${Utils.escapeHtml(team.registerNumber)}</strong></div>
      </div>

      <h3 class="text-sm mb-1">Update Project Progress</h3>
      <form onsubmit="MentorPortal.saveTeamProgress(event, '${Utils.escapeHtml(teamId)}')" class="mb-3">
        <div class="grid-3">
          <div class="form-group"><label class="form-label">Project Status</label><select id="mpStatus" class="form-control">${statuses.map(st=>`<option ${p.status===st?'selected':''}>${st}</option>`).join('')}</select></div>
          <div class="form-group"><label class="form-label">Completion % (0–100)</label><input id="mpPct" type="number" min="0" max="100" class="form-control" value="${p.pct || 0}" required /></div>
          <div class="form-group"><label class="form-label">Review Date</label><input id="mpDate" type="date" class="form-control" value="${new Date().toISOString().slice(0,10)}" /></div>
        </div>
        <div class="form-group"><label class="form-label">Progress Remarks & Feedback</label><textarea id="mpRemarks" class="form-control" rows="2" placeholder="Enter milestone remarks & feedback...">${Utils.escapeHtml(p.remarks || '')}</textarea></div>
        <button type="submit" class="btn btn-primary btn-sm">Save Progress Update</button>
      </form>

      <h3 class="text-sm mb-1">Assigned Games (${games.length})</h3>
      <div style="display:grid; gap:0.5rem; max-height:220px; overflow-y:auto;" class="mb-3">
        ${games.map(g => `<div style="padding:0.6rem; border:1px solid var(--border-subtle); border-radius:8px;"><strong>${Utils.escapeHtml(g.gameId)}: ${Utils.escapeHtml(g.title)}</strong> <span class="badge badge-blue">${Utils.escapeHtml(g.genre)}</span> <span class="badge ${Utils.diffBadgeClass(g.difficulty)}">${Utils.escapeHtml(g.difficulty)}</span><div class="text-xs text-muted mt-1">${Utils.escapeHtml(g.coreMechanic)} — ${Utils.escapeHtml(g.description)}</div></div>`).join('') || '<div class="text-xs text-muted">No games allocated yet.</div>'}
      </div>

      <h3 class="text-sm mb-1">Progress History (${hist.length})</h3>
      <div style="max-height:150px; overflow-y:auto;">
        ${hist.map(h => `<div class="text-xs text-muted mb-1">• <strong>${Utils.escapeHtml(h.previousStatus)} (${h.previousPct}%) → ${Utils.escapeHtml(h.newStatus)} (${h.newPct}%)</strong> | ${Utils.escapeHtml(h.remarks)} <em>[${new Date(h.updatedAt).toLocaleString()}]</em></div>`).join('') || '<div class="text-xs text-muted">No updates recorded yet.</div>'}
      </div>
    `);
  },
  async saveTeamProgress(e, teamId) {
    e.preventDefault();
    const s = this.getSession(); if (!s) return;
    const team = AppState.teams.find(t => t.teamId === teamId);
    if (!team || team.facultyMentor !== s.displayName) { Utils.toast('Forbidden.', 'error'); return; }
    const prev = AppState.teamProgress[teamId] || { status: 'Not Started', pct: 0 };
    const newStatus = document.getElementById('mpStatus').value;
    const newPct = Math.min(100, Math.max(0, Number(document.getElementById('mpPct').value) || 0));
    const remarks = document.getElementById('mpRemarks').value.trim();
    const reviewDate = document.getElementById('mpDate').value;
    const now = new Date().toISOString();

    AppState.teamProgress[teamId] = { status: newStatus, pct: newPct, remarks, reviewDate, updatedAt: now };
    AppState.progressHistory.unshift({ teamId, mentorId: s.username, mentorName: s.displayName, previousStatus: prev.status, newStatus, previousPct: prev.pct || 0, newPct, remarks, reviewDate, updatedAt: now });
    await DataRepository.saveState(['teamProgress', 'progressHistory']);
    await DataRepository.logAudit('MENTOR_PROGRESS', `${s.username} updated ${teamId}: ${newStatus} (${newPct}%)`);
    ModalUI.close(); this.renderDashboard(); Utils.toast(`Saved progress for ${teamId}`, 'success');
  },
  async exportMyReport() {
    const s = this.getSession(); if (!s) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('My Assigned Teams');
    ws.addRow(['Team ID', 'Team Leader', 'Department', 'Class', 'Register No', 'Project Status', 'Completion %', 'Remarks']);
    this.getMyTeams().forEach(t => {
      const p = AppState.teamProgress[t.teamId] || { status: 'Not Started', pct: 0, remarks: '' };
      ws.addRow([t.teamId, t.leaderName, t.department, t.leaderClass || t.classSheet, t.registerNumber, p.status, p.pct || 0, p.remarks || '']);
    });
    await ExportModule.dl(wb, `Mentor_${s.username}_Progress_Report.xlsx`);
  }
};

const App = {
  async autoHydrateRoster() {
    // 1. Try loading published-data.json (contains real 1,750 games, 263 sanitized teams, and published allocation)
    try {
      const pubRes = await fetch('./published-data.json');
      if (pubRes.ok) {
        const pub = await pubRes.json();
        if (Array.isArray(pub.games) && pub.games.length === 1750 && Array.isArray(pub.teams) && pub.teams.length === 263 && Array.isArray(pub.publishedAllocations) && pub.publishedAllocations.length === 1750) {
          if (AppState.games.length === 0) AppState.games = pub.games;
          if (AppState.teams.length === 0) AppState.teams = pub.teams;
          if (AppState.publishedAllocations.length === 0) {
            AppState.publishedAllocations = pub.publishedAllocations;
            AppState.allocations = pub.publishedAllocations;
            AppState.teamMeta = pub.teamMeta || {};
            AppState.sixGameTeams = pub.sixGameTeams || [];
            AppState.settings.published = true;
          }
          await DataRepository.saveState(['games','teams','allocations','publishedAllocations','teamMeta','sixGameTeams','settings']);
          this.refreshAllUI();
          return true;
        }
      }
    } catch (err) {
      console.warn('published-data.json not loaded:', err.message);
    }
    // 2. Fallback: load 263-team roster directly from deployed PDF
    if (AppState.teams.length === 263) return true;
    try {
      const res = await fetch('./SoISDS-2D_Games_Team_Leaders_with_Mentors_T001-T263-v2.pdf');
      if (!res.ok) return false;
      const { teams } = await PdfRosterModule.extractFromArrayBuffer(await res.arrayBuffer());
      if (teams.length > 0) {
        AppState.teams = teams;
        AllocationEngine.autoSelectSixGameTeams();
        await DataRepository.saveState(['teams', 'sixGameTeams']);
        this.refreshAllUI();
        return true;
      }
    } catch (err) {
      console.warn('Auto-hydrate roster skipped:', err.message);
    }
    return false;
  },
  async init() {
    if (localStorage.getItem(LS_KEYS.THEME) === 'dark') document.documentElement.classList.replace('light', 'dark');
    await DataRepository.init();
    await DataRepository.loadAll();
    if ((AppState.teams.length === 0 || !AppState.settings.published) && !AppState.settings.apiBaseUrl && window.location.protocol.startsWith('http')) {
      await this.autoHydrateRoster();
    }
    LibraryModule.init(); GameManager.init(); TeamManager.init(); PreviewModule.init();
    AuthModule.syncNav(); MentorPortal.syncNav(); AuthModule.renderAuthView(); this.refreshAllUI();
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
    if (sec === 'mentor-dashboard' && !MentorPortal.isAuthenticated()) sec = 'mentor-login';
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`section-${sec}`)?.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === sec));
    document.getElementById('mainNavLinks').classList.remove('open');
    if (sec === 'admin-login') AuthModule.renderAuthView();
    if (sec === 'admin-dashboard') AdminUI.renderOverview();
    if (sec === 'mentor-dashboard') MentorPortal.renderDashboard();
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
  