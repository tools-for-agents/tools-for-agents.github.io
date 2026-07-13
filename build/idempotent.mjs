#!/usr/bin/env node
// idempotent.mjs — IS `idempotentHint: true` TRUE?
//
// The fourth annotation. honest/sealed/additive cover the safety hints (writes? destroys? phones
// home?). This one covers the RETRY hint: idempotentHint:true says calling the tool again with the
// same arguments has no additional effect — so a client may safely retry it after a dropped
// response, and an agent may re-issue it without piling up duplicates.
//
// A tool that claims this and actually creates a NEW record every call is a slow-motion data bug:
// retry logic and re-issued calls quietly flood the store with duplicates, and nothing warns you,
// because the annotation said it was safe.
//
//     A TOOL THAT SAYS "CALLING ME TWICE IS THE SAME AS ONCE" MUST MEAN IT.
//
// ── THE CHECK, REUSING additive.mjs's IDENTITY SNAPSHOT ──────────────────────────────────────
// Call each idempotent+writing tool ONCE (snapshot the primary-key set), then AGAIN with the exact
// same arguments (snapshot again). The second call must introduce NO NEW primary key. An idempotent
// write upserts — same title → same slug, same name → same agent id — so the key set is unchanged.
// A tool that mints a fresh id on the second call (agent_register was the one to watch — it does
// NOT, it upserts by name) would add a key, and that is the label being false.
//
// Not "state is byte-identical": an idempotent re-write legitimately bumps updated_at. Identity is
// the right lens here too — a second call must not CREATE anything, timestamps aside.

import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const rootArg = process.argv.indexOf('--root');
const ROOT = resolve(rootArg >= 0 ? process.argv[rootArg + 1] : '.');
const ONLY = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--root');

function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180_000 });
  return (r.stdout || '') + (r.stderr || '');
}

// Snapshot the SET of primary keys per table. `tables` is { tableName: 'pkExpr' } — pkExpr is a SQL
// expression that identifies a record (a column, or `a||'|'||b` for a composite key). A function of
// the env we handed it, so it reads the SAME store the MCP server writes to.
const snapshotKeys = (db, tables) => {
  if (!existsSync(db)) return null;
  const d = new DatabaseSync(db, { readOnly: true });
  const out = {};
  try {
    for (const [t, pk] of Object.entries(tables)) {
      try { out[t] = new Set(d.prepare(`SELECT ${pk} AS k FROM ${t}`).all().map((r) => String(r.k))); }
      catch { /* table absent → skip */ }
    }
  } finally { d.close(); }
  return out;
};

const SERVERS = [
  { name: 'lens', env: (d) => ({ LENS_DB: join(d, 'code.db') }),
    setup: (r, e) => sh('node', ['src/cli.js', 'index', 'src'], r, e),
    count: (e) => snapshotKeys(e.LENS_DB, { files: 'path' }) },

  { name: 'cortex', env: (d) => ({ CORTEX_VAULT: join(d, 'vault') }),
    setup: (r, e) => sh('node', ['scripts/seed.js'], r, e),
    count: (e) => snapshotKeys(join(e.CORTEX_VAULT, '.cortex', 'index.db'), { notes: 'slug' }) },

  { name: 'scout', env: (d) => ({ SCOUT_DB: join(d, 'cache.db') }),
    setup: (r, e) => sh('node', ['scripts/seed.js'], r, e),
    count: (e) => snapshotKeys(e.SCOUT_DB, { pages: 'url' }) },

  { name: 'anvil', env: (d) => ({ ANVIL_DB: join(d, 'runs.db') }),
    setup: (r, e) => sh('node', ['scripts/seed.js'], r, e),
    count: (e) => snapshotKeys(e.ANVIL_DB, { runs: 'id' }) },

  { name: 'iris', env: (d) => ({ IRIS_OUT: join(d, 'iris') }),
    setup: (r, e) => sh('node', ['src/cli.js', 'look', 'test/fixtures/clean.html', '--viewports', 'desktop', '--themes', 'dark'], r, e),
    // iris stores each run as a directory under IRIS_OUT — a "record" is a run dir.
    count: (e) => (existsSync(e.IRIS_OUT) ? { runs: new Set(readdirSync(e.IRIS_OUT).filter((f) => statSync(join(e.IRIS_OUT, f)).isDirectory())) } : null) },

  { name: 'agent-hq', env: (d) => ({ HQ_DB_PATH: join(d, 'hq.db'), HQ_URL: 'http://localhost:7793', PORT: '7793' }),
    http: true,
    setup: (r, e) => sh('node', ['scripts/seed.js'], r, e),
    // the additive tools touch different tables; count every user table, since a delete in ANY is a lie.
    count: (e) => snapshotKeys(e.HQ_DB_PATH, { tasks: 'id', memories: 'id', agents: 'id', runs: 'id', messages: 'id', task_deps: "task_id||'|'||depends_on" }) },

  // recall federates over its siblings and owns no store — it has no destructiveHint:false writing
  // tool of its own to check. Named here so a run that skips it says WHY, not silently.
  { name: 'recall', skip: 'federates; owns no store and has no idempotent writing tool of its own' },
];

async function withServer(repo, env, fn) {
  const proc = spawn('node', ['mcp/mcp-server.js'], { cwd: repo, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map();
  proc.stdout.on('data', (d) => {
    buf += d;
    for (let nl; (nl = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); }
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((res, rej) => {
    const myId = ++id;
    waiters.set(myId, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => { if (waiters.delete(myId)) rej(new Error(`${repo}: ${method} timed out`)); }, 60_000);
  });
  const close = () => new Promise((res) => { proc.once('exit', res); proc.stdin.end(); proc.kill(); });
  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'idempotent', version: '1' } });
    return await fn(call);
  } finally { await close(); }
}

// Arguments good enough to make a tool actually do its work — from its own inputSchema. A tool that
// bails on a bad arg writes nothing, which passes trivially; we want it to actually run.
function argsFor(tool) {
  const s = tool.inputSchema || {}, props = s.properties || {}, a = {};
  for (const k of s.required || []) {
    const p = props[k] || {};
    if (p.enum?.length) a[k] = p.enum[0];
    else if (p.type === 'number' || p.type === 'integer') a[k] = 1;
    else if (p.type === 'boolean') a[k] = false;
    else if (p.type === 'array') a[k] = [];
    else if (p.type === 'object') a[k] = {};
    else if (/url/i.test(k)) a[k] = 'https://example.com/idempotent-probe';
    else if (/path|dir|file/i.test(k)) a[k] = '.';
    else a[k] = 'idempotent-probe';
  }
  return a;
}

// Keys that appeared on the SECOND call — a record the idempotent tool created when it should have
// recognised the first one. after1 = state after call 1; after2 = state after the identical call 2.
const createdOnRetry = (after1, after2) => {
  const out = [];
  for (const [t, keys] of Object.entries(after2 || {})) {
    const first = after1?.[t] ?? new Set();
    const fresh = [...keys].filter((k) => !first.has(k));
    if (fresh.length) out.push(`${t}: ${fresh.length} DUPLICATE record(s) created (e.g. ${fresh.slice(0, 3).join(', ')})`);
  }
  return out;
};

let failed = 0, called = 0, checkedServers = 0;
for (const s of SERVERS) {
  if (ONLY.length && !ONLY.includes(s.name)) continue;
  if (s.skip) { console.log(`· ${s.name}: skipped — ${s.skip}`); continue; }
  const repo = resolve(ROOT, s.name);
  if (!existsSync(join(repo, 'mcp', 'mcp-server.js'))) {
    failed++; console.error(`✗ ${s.name}: no MCP server at ${repo} — cannot check what I cannot find`);
    continue;
  }

  const store = mkdtempSync(join(tmpdir(), `idempotent-${s.name}-`));
  const env = s.env(store);
  let platform = null;
  if (s.http) {
    platform = spawn('node', ['src/server.js'], { cwd: repo, env: { ...process.env, ...env }, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${env.HQ_URL}/api/health`); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    s.setup?.(repo, env, store);
    const before = s.count(env);
    if (!before || !Object.keys(before).length || !Object.values(before).some((s) => s.size > 0)) {
      failed++;
      console.error(`✗ ${s.name}: the store is EMPTY after seeding — an additive tool with nothing to delete `
        + 'cannot prove it does not delete. That is not a pass; it is a blank page.');
      continue;
    }

    await withServer(repo, env, async (call) => {
      const tools = (await call('tools/list', {})).result?.tools || [];
      // The tools under test: they WRITE (not read-only) and PROMISE a retry is free (idempotent).
      const idem = tools.filter((t) => t.annotations?.readOnlyHint === false && t.annotations?.idempotentHint === true);
      if (!idem.length) { console.log(`· ${s.name}: no idempotent (write) tools declared`); return; }

      const offenders = [];
      for (const t of idem) {
        const args = argsFor(t);
        await call('tools/call', { name: t.name, arguments: args });
        const after1 = s.count(env);
        await call('tools/call', { name: t.name, arguments: args });   // the exact same call again
        const after2 = s.count(env);
        called++;
        const dupes = createdOnRetry(after1, after2);
        if (dupes.length) offenders.push(`${t.name} → ${dupes.join(', ')}`);
      }
      if (offenders.length) {
        failed++;
        console.error(`\n✗ ${s.name}: ${offenders.length} tool(s) declare idempotentHint:true AND CREATED A DUPLICATE ON THE SECOND CALL:`);
        for (const o of offenders) console.error(`    ${o}`);
        console.error('  A tool that says a retry is free must mean it — else retry logic floods the store.');
      } else {
        console.log(`✓ ${s.name}: ${idem.length} idempotent tools ran twice, and the second call created nothing`);
      }
    });
    checkedServers++;
  } catch (e) {
    failed++; console.error(`✗ ${s.name}: ${e.message}`);
  } finally {
    if (platform) { platform.kill(); await new Promise((r) => platform.once('exit', r)); }
    rmSync(store, { recursive: true, force: true });
  }
}

console.log(`\n${called} idempotent tools called (twice each) across ${checkedServers} servers.`);
if (failed) { console.error(`${failed} server(s) broke their own promise.`); process.exit(1); }
if (!called) { console.error('NOTHING WAS CHECKED — not a clean bill of health.'); process.exit(1); }
console.log('Every idempotentHint:true tool is safe to retry.');
