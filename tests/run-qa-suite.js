const { spawn } = require('child_process');
const path = require('path');

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function req(url, opts = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body, ms: performance.now() - t0 };
  } catch (err) {
    return { status: 0, error: err.message, ms: performance.now() - t0 };
  }
}

async function runConcurrentBatch(name, vus, durationMs, fn) {
  const latencies = [];
  const counts = { '2xx': 0, '4xx': 0, '5xx': 0, err: 0 };
  const start = Date.now();
  const workers = Array.from({ length: vus }, async (_, idx) => {
    while (Date.now() - start < durationMs) {
      const r = await fn(idx);
      latencies.push(r.ms);
      if (r.status >= 200 && r.status < 300) counts['2xx']++;
      else if (r.status >= 400 && r.status < 500) counts['4xx']++;
      else if (r.status >= 500) counts['5xx']++;
      else counts.err++;
      await new Promise(r => setTimeout(r, 100));
    }
  });
  await Promise.all(workers);
  const totalSec = (Date.now() - start) / 1000;
  const totalReq = latencies.length;
  const avg = latencies.reduce((a, b) => a + b, 0) / Math.max(1, totalReq);
  const out = {
    scenario: name,
    vus,
    totalReq,
    rps: +(totalReq / totalSec).toFixed(1),
    avgMs: +avg.toFixed(1),
    p50Ms: +percentile(latencies, 50).toFixed(1),
    p95Ms: +percentile(latencies, 95).toFixed(1),
    p99Ms: +percentile(latencies, 99).toFixed(1),
    ...counts,
    failPct: +(((counts['5xx'] + counts.err) / Math.max(1, totalReq)) * 100).toFixed(2)
  };
  console.log(JSON.stringify(out));
  return out;
}

(async () => {
  // 1. Functional, RBAC, Security & Rate-Limit Server (default strict limits)
  const srv1 = spawn('node', [path.resolve(__dirname, '../server/server.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: 'pipe'
  });
  for (let i = 0; i < 40; i++) {
    const h = await req(`${BASE}/api/health`);
    if (h.status === 200 && JSON.parse(h.body).dbConnected) break;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('=== PHASE 4 & 7: API, RBAC, SECURITY & RATE LIMIT TESTS ===');
  const health = await req(`${BASE}/api/health`);
  const ready = await req(`${BASE}/api/ready`);
  const t001 = await req(`${BASE}/api/portal/team/T001`);
  const t999 = await req(`${BASE}/api/portal/team/T999`);
  const gamesP1 = await req(`${BASE}/api/games?page=1&limit=25`);
  const unauthAdmin = await req(`${BASE}/api/admin/dashboard`);
  const unauthMentor = await req(`${BASE}/api/mentor/teams`);

  // NoSQL injection probe on team lookup & login
  const nosqlRes = await req(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: { $ne: '' }, password: { $ne: '' } })
  });

  // Mentor login (priya / pass123) + cross-mentor boundary check (T100 belongs to Dr.A.Sumathi)
  const mentorLogin = await req(`${BASE}/api/mentor/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'priya', password: 'pass123' })
  });
  const mentorCookie = (mentorLogin.headers.get('set-cookie') || '').split(';')[0];
  const mentorTeams = await req(`${BASE}/api/mentor/teams`, { headers: { Cookie: mentorCookie } });
  const crossMentor = await req(`${BASE}/api/mentor/progress`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mentorCookie },
    body: JSON.stringify({ teamId: 'T100', newStatus: 'Testing', newPct: 50 })
  });
  const mentorToAdmin = await req(`${BASE}/api/admin/dashboard`, { headers: { Cookie: mentorCookie } });

  // Rate limit trigger test on /api/auth/login (limit = 5 / 15min)
  let rl429 = null;
  for (let i = 0; i < 6; i++) {
    const r = await req(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' })
    });
    if (r.status === 429) { rl429 = { status: r.status, retryAfter: r.headers.get('retry-after'), body: r.body }; break; }
  }

  console.log(JSON.stringify({
    health: health.status,
    ready: ready.status,
    t001: { status: t001.status, games: JSON.parse(t001.body).games?.length },
    t999Invalid: t999.status,
    gamesPage1: { status: gamesP1.status, count: JSON.parse(gamesP1.body).items?.length, total: JSON.parse(gamesP1.body).total },
    unauthAdmin: unauthAdmin.status,
    unauthMentor: unauthMentor.status,
    nosqlSanitizedStatus: nosqlRes.status,
    mentorLogin: mentorLogin.status,
    mentorTeamsCount: JSON.parse(mentorTeams.body).teams?.length,
    crossMentorForbidden: crossMentor.status,
    mentorToAdminRejected: mentorToAdmin.status,
    rateLimit429: rl429
  }, null, 2));

  srv1.kill();
  await new Promise(r => setTimeout(r, 500));

  // 2. Concurrent Load & Stress Testing Server (high limits for capacity benchmarking)
  const srv2 = spawn('node', [path.resolve(__dirname, '../server/server.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', RL_STANDARD_MAX: '50000', RL_SEARCH_MAX: '50000' },
    stdio: 'pipe'
  });
  for (let i = 0; i < 40; i++) {
    const h = await req(`${BASE}/api/health`);
    if (h.status === 200 && JSON.parse(h.body).dbConnected) break;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n=== PHASE 2: CONCURRENT USER LOAD & STRESS BENCHMARKS ===');
  const workload = (idx) => {
    const tid = 'T' + String((idx % 263) + 1).padStart(3, '0');
    return idx % 3 === 0 ? req(`${BASE}/api/games?page=${(idx % 10) + 1}&limit=25`) : req(`${BASE}/api/portal/team/${tid}`);
  };

  const results = [];
  results.push(await runConcurrentBatch('A: Normal Load', 50, 3000, workload));
  results.push(await runConcurrentBatch('B: Expected Load', 100, 3000, workload));
  results.push(await runConcurrentBatch('C: Full Capacity (279 VUs)', 279, 4000, workload));
  results.push(await runConcurrentBatch('D: Stress Test (350 VUs)', 350, 4000, workload));
  results.push(await runConcurrentBatch('E: High Stress (450 VUs)', 450, 3000, workload));
  results.push(await runConcurrentBatch('F: Extreme Stress (550 VUs)', 550, 3000, workload));
  await runConcurrentBatch('G1: Pre-Spike Baseline', 20, 1500, workload);
  results.push(await runConcurrentBatch('G2: Spike (20 -> 279 VUs)', 279, 3000, workload));
  results.push(await runConcurrentBatch('G3: Post-Spike Recovery', 20, 1500, workload));

  console.table(results);
  srv2.kill();
  process.exit(0);
})();
