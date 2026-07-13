#!/usr/bin/env node
// honest.mjs — IS `readOnlyHint: true` TRUE?
//
// Cycle 11 gave all 67 tools MCP annotations: 37 read-only, 7 destructive, 10 open-world.
// `routable.mjs` checks the annotations EXIST — because silence means "destructive" under the
// spec's pessimistic defaults, and a tool that declares nothing declares the worst.
//
// NOBODY HAS EVER CHECKED THEY ARE TRUE.
//
// `readOnlyHint: true` is not decoration. It is a PROMISE TO THE CLIENT — and a conformant
// client acts on it: it may call the tool without stopping to ask the user, because we said it
// does not touch anything. A "read-only" tool that writes has not just got a wrong label; it has
// walked straight through the one gate that was standing between it and the user's data.
//
//     A PROMISE NOBODY CHECKS IS A PROMISE YOU HAVE ONLY MADE TO YOURSELF.
//
// ── HOW ─────────────────────────────────────────────────────────────────────────────────────
// Calling with `{}` proves nothing: most tools bail at argument validation and never do any
// work, so the store is untouched for the most boring reason there is — a check that can only
// pass. (That is the "constant wearing a function's clothes" I have written twice already.)
//
// So: give every read-only tool ARGUMENTS GOOD ENOUGH TO MAKE IT ACTUALLY WORK, derived from
// its own inputSchema. Then hash the entire world it can reach — the repo AND its store — before
// and after, and demand not one byte moved.
//
// This also catches, for every read-only tool at once, the bug that took cycles 14, 15 and 16:
// a read that CREATES the store it is reading from, then answers out of the empty thing it just
// made. (`cortex search` used to leave a vault/ in whatever directory you ran it in.)
//
//   node build/honest.mjs                 # all 7, against the sibling checkouts
//   node build/honest.mjs cortex lens     # just these

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Where the seven checkouts live. In CI they are cloned as siblings; locally, pass --root.
const rootArg = process.argv.indexOf('--root');
const ROOT = resolve(rootArg >= 0 ? process.argv[rootArg + 1] : '.');
const ONLY = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--root');

// Each server, and the env that points its store at a scratch dir we can watch.
const SERVERS = [
  { name: 'lens',   env: (d) => ({ LENS_DB: join(d, 'code.db') }),
    // lens has no seed script — it indexes a real tree. Point it at its own source.
    setup: (repo, env) => sh('node', ['src/cli.js', 'index', 'src'], repo, env),
    nonEmpty: (repo, env) => +sh('node', ['-e', "import('./src/core.js').then(m=>console.log(m.stats().files))"], repo, env) > 0 },

  { name: 'cortex', env: (d) => ({ CORTEX_VAULT: join(d, 'vault') }),
    setup: (repo, env) => sh('node', ['scripts/seed.js'], repo, env),
    nonEmpty: (repo, env) => +sh('node', ['-e', "import('./src/core.js').then(m=>console.log(m.stats().notes))"], repo, env) > 0 },

  { name: 'scout',  env: (d) => ({ SCOUT_DB: join(d, 'cache.db') }),
    setup: (repo, env) => sh('node', ['scripts/seed.js'], repo, env),
    nonEmpty: (repo, env) => +sh('node', ['-e', "import('./src/core.js').then(m=>console.log(m.stats().pages))"], repo, env) > 0 },

  { name: 'anvil',  env: (d) => ({ ANVIL_DB: join(d, 'runs.db') }),
    setup: (repo, env) => sh('node', ['scripts/seed.js'], repo, env),
    nonEmpty: (repo, env) => +sh('node', ['-e', "import('./src/log.js').then(m=>console.log(m.recentRuns().count))"], repo, env) > 0 },

  { name: 'recall', env: (d) => ({ RECALL_CORTEX_DB: join(d, 'seed/brain.db'), RECALL_SCOUT_DB: join(d, 'seed/reading.db'), RECALL_LENS_DB: join(d, 'seed/code.db') }),
    // recall federates over its three siblings' stores; its seed builds all three.
    setup: (repo, env, store) => sh('node', ['scripts/seed.js', join(store, 'seed')], repo, env),
    nonEmpty: (repo, env, store) => existsSync(join(store, 'seed', 'brain.db')) },

  { name: 'iris',   env: (d) => ({ IRIS_OUT: join(d, 'iris') }),
    // iris's read-only tools report on PAST RUNS. With no run to report on they answer nothing
    // and write nothing — a pass that proves nothing. So give it a real run to look at.
    setup: (repo, env) => sh('node', ['src/cli.js', 'look', 'test/fixtures/clean.html', '--viewports', 'desktop', '--themes', 'dark'], repo, env),
    nonEmpty: (repo, env, store) => existsSync(join(store, 'iris')) && readdirSync(join(store, 'iris')).length > 0 },

  { name: 'agent-hq', env: (d) => ({ HQ_DB_PATH: join(d, 'hq.db'), HQ_URL: 'http://localhost:7788', PORT: '7788' }),
    // agent-hq's 28 MCP tools are a SKIN OVER ITS HTTP API (cycle 8) — with the platform down
    // every one of them fails at the fetch and writes nothing, which would pass this check for
    // the most useless reason there is. Bring the platform up and seed it.
    http: true,
    setup: (repo, env) => sh('node', ['scripts/seed.js'], repo, env),
    nonEmpty: (repo, env) => +sh('node', ['-e', "import('./src/services.js').then(m=>console.log(m.Tasks.list().length))"], repo, env) > 0 },
];

// run a command in a repo and hand back its stdout, trimmed
function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180_000 });
  return (r.stdout || '').trim();
}

// ── the fingerprint of everything a tool could touch ────────────────────────────────────────
const SKIP = new Set(['.git', 'node_modules']);
// ── THE -wal FILE IS NOT NOISE. IT IS THE EVIDENCE. ─────────────────────────────────────────
//
// My first cut skipped `-wal` and `-shm` together as "SQLite's own scratch". It was half right
// and completely wrong: IN WAL MODE A WRITE GOES TO THE -wal FILE FIRST, and the main .db is
// not touched until a checkpoint. So excluding -wal excluded the only place the evidence lives.
//
// I proved it by planting an INSERT inside cortex_search — a readOnlyHint:true tool writing a
// note on every search — and the check said "not one byte moved". A CHECK THAT CANNOT FAIL,
// written by me, in a script whose entire purpose is to catch a promise nobody verified.
//
// -shm is different: it is the shared-memory index, and it genuinely churns when you merely
// READ. That one is noise. -wal is signal. They are not the same thing and must not be skipped
// with the same regex.
// ── HASH AFTER THE SERVER HAS CLOSED, NOT WHILE IT IS OPEN ──────────────────────────────────
//
// My first cut skipped `-wal` and `-shm` together as "SQLite's own scratch". It was half right
// and completely wrong: IN WAL MODE A WRITE GOES TO THE -wal FILE FIRST, and the main .db is
// not touched until a checkpoint. So excluding -wal excluded the only place the evidence lives.
// I proved it by planting an INSERT inside cortex_search — a readOnlyHint:true tool writing a
// note on every search — and the check said "not one byte moved". A CHECK THAT CANNOT FAIL,
// written by me, in a script whose whole purpose is to catch a promise nobody verified.
//
// But INCLUDING -wal is wrong too: SQLite creates one the moment you OPEN a WAL database, even
// to read, so its mere existence proves nothing and every clean read looked like a write.
//
// The answer is not a cleverer filename filter. It is to ASK THE QUESTION AT THE RIGHT MOMENT:
// close the server first. On the last connection close SQLite CHECKPOINTS — any write folds
// into the .db and the -wal is removed. So a sneaky write shows up in the .db hash, and an
// honest read leaves the .db byte-identical. The sidecars are gone by then and there is nothing
// left to argue about.
const SIDECAR = /-(wal|shm|journal)$/;
function fingerprint(dir, out = new Map(), base = dir) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || SIDECAR.test(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) fingerprint(p, out, base);
    else if (e.isFile()) {
      try {
        const h = createHash('sha1').update(readFileSync(p)).digest('hex');
        out.set(p.slice(base.length + 1), `${h}:${statSync(p).size}`);
      } catch { /* vanished mid-walk: it changed, and the diff will say so */ }
    }
  }
  return out;
}
const diff = (a, b) => {
  const changed = [];
  for (const [k, v] of b) if (!a.has(k)) changed.push(`+ ${k}`); else if (a.get(k) !== v) changed.push(`~ ${k}`);
  for (const k of a.keys()) if (!b.has(k)) changed.push(`- ${k}`);
  return changed;
};

// ── arguments good enough to make a tool actually do its work ───────────────────────────────
// Derived from the tool's OWN inputSchema, so this does not rot when a tool changes.
// A read-only tool handed a query that matches nothing still SEARCHES — and must still write
// nothing. That is the property under test.
function argsFor(tool) {
  const s = tool.inputSchema || {};
  const props = s.properties || {};
  const required = s.required || [];
  const a = {};
  for (const k of required) {
    const p = props[k] || {};
    if (p.enum?.length) a[k] = p.enum[0];
    else if (p.type === 'number' || p.type === 'integer') a[k] = 1;
    else if (p.type === 'boolean') a[k] = false;
    else if (p.type === 'array') a[k] = [];
    else if (p.type === 'object') a[k] = {};
    else if (/url/i.test(k)) a[k] = 'https://example.com/';
    else if (/path|dir|file/i.test(k)) a[k] = '.';
    else a[k] = 'honest';           // a query that finds nothing is still a query
  }
  return a;
}

// ── talk to one MCP server over stdio, the wire a model actually uses ───────────────────────
async function withServer(repo, env, fn) {
  const proc = spawn('node', ['mcp/mcp-server.js'], {
    cwd: repo, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = new Map();
  proc.stdout.on('data', (d) => {
    buf += d;
    for (let nl; (nl = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch {
        // stdout IS the protocol. A line that is not a message desyncs the session.
        throw new Error(`${repo}: NON-JSON ON STDOUT — the protocol is broken: ${line.slice(0, 120)}`);
      }
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
  // A CLEAN EXIT, NOT A KILL. SIGTERM does not run exit handlers, so SQLite never checkpoints
  // and the sneaky write stays in the -wal — which is exactly where this check is not looking.
  // I proved that too: the planted INSERT still passed until the server was allowed to close
  // properly. Ending stdin lets the read loop finish and the process exit on its own, which
  // closes the database, which checkpoints, which puts the evidence in the .db where it belongs.
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((res) => {
      const done = () => { clearTimeout(hard); res(); };
      proc.once('exit', done);
      proc.stdin.end();                                     // EOF: exit the read loop, cleanly
      const hard = setTimeout(() => { proc.kill('SIGKILL'); res(); }, 8000);  // only if it hangs
    });
  };
  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'honest', version: '1' } });
    return await fn(call, close);
  } finally { await close(); }
}

let failed = 0, checked = 0, wrote = 0;
for (const s of SERVERS) {
  if (ONLY.length && !ONLY.includes(s.name)) continue;
  const repo = resolve(ROOT, s.name);
  // A SERVER I COULD NOT FIND IS NOT A SERVER THAT PASSED. Skipping quietly is how a check
  // reports "all clear" having done nothing at all — which it did, to me, on the first run:
  // it printed "Every readOnlyHint:true is TRUE" after checking ZERO tools.
  if (!existsSync(join(repo, 'mcp', 'mcp-server.js'))) {
    failed++; console.error(`✗ ${s.name}: no MCP server at ${repo} — I cannot check what I cannot find`);
    continue;
  }

  const store = mkdtempSync(join(tmpdir(), `honest-${s.name}-`));
  const env = s.env(store);
  // agent-hq's 28 MCP tools are a SKIN OVER ITS HTTP API (cycle 8). With the platform down every
  // one of them dies at the fetch and writes nothing — which would sail through this check
  // having exercised precisely none of the code it claims to be checking.
  let platform = null;
  if (s.http) {
    platform = spawn('node', ['src/server.js'], { cwd: repo, env: { ...process.env, ...env }, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${env.HQ_URL}/api/health`); if (r.ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    await withServer(repo, env, async (call, close) => {
      const listed = await call('tools/list', {});
      const tools = listed.result?.tools || [];
      const ro = tools.filter((t) => t.annotations?.readOnlyHint === true);
      if (!ro.length) { console.log(`· ${s.name}: no read-only tools declared`); return; }

      // A READ-ONLY TOOL WITH NOTHING TO READ WRITES NOTHING, FOR THE MOST USELESS REASON THERE
      // IS. An empty store makes every tool bail early and this whole check pass on an empty
      // room — the exact fault that let seven UI gates audit blank pages for months. So seed
      // it, and then DEMAND it is not empty before believing a single pass.
      // FINGERPRINT THE REPO BEFORE ANYTHING RUNS — including the seed.
      //
      // I planted a tool that drops a LITTER.txt into the working directory, and this check
      // waved it through. The seed script calls the very same write() path, so the litter was
      // already there when the "before" snapshot was taken, and it cancelled itself out of the
      // diff. A file that exists in both snapshots is invisible, however wrong it is.
      //
      // Nothing here has any business writing into the repo — not the tools, and not the seed,
      // which writes to the STORE. So the baseline is the repo as it was found, before a single
      // line of this ran.
      const repoAtStart = fingerprint(repo);

      s.setup?.(repo, env, store);
      if (s.nonEmpty && !s.nonEmpty(repo, env, store)) {
        throw new Error('the store is EMPTY after seeding — every read-only tool would bail early '
          + 'and pass this check without doing any work. That is not a pass; it is a blank page.');
      }

      const beforeRepo = fingerprint(repo), beforeStore = fingerprint(store);

      for (const t of ro) {
        await call('tools/call', { name: t.name, arguments: argsFor(t) });
        checked++;
      }

      // Close FIRST: the checkpoint on close is what makes a WAL write visible in the .db.
      await close();
      const dRepo = diff(beforeRepo, fingerprint(repo));
      const dStore = diff(beforeStore, fingerprint(store));
      if (dRepo.length || dStore.length) {
        failed++;
        console.error(`\n✗ ${s.name}: ${ro.length} tools declare readOnlyHint:true — AND SOMETHING WROTE.`);
        for (const c of [...dRepo.map((x) => `  repo  ${x}`), ...dStore.map((x) => `  store ${x}`)].slice(0, 20)) console.error(c);
        console.error('  A read-only tool that writes is not a wrong label — it is a tool that walked');
        console.error('  through the one gate standing between it and the user\'s data.');
        return;
      }
      console.log(`✓ ${s.name}: ${ro.length} read-only tools ran, and not one byte moved`);

      // ── PHASE 2: THE WRITERS MAY WRITE — BUT ONLY WHERE THEY SAID THEY WOULD ────────────
      //
      // A tool has a store, and the user has a working directory, and the two are not the same
      // place. cortex used to leave a vault/ in whatever directory you happened to ask it a
      // question in; lens left a .lens/, scout a .scout/. Cycle 16 stopped the READS from doing
      // that. NOBODY EVER CHECKED THE WRITES.
      //
      // So call the other 30 tools — the ones that are supposed to write — and demand the
      // writing lands in the STORE and nowhere else. The repo (standing in for the user's cwd)
      // must come back byte-identical.
      // Phase 1 CLOSED the server (the checkpoint on close is what makes a WAL write visible),
      // so the writers need a server of their own. Same wall, fresh process.
      const writers = tools.filter((t) => t.annotations?.readOnlyHint !== true);
      await withServer(repo, env, async (call2, close2) => {
        for (const t of writers) {
          await call2('tools/call', { name: t.name, arguments: argsFor(t) });
          wrote++;
        }
        await close2();
      });
      const litter = diff(repoAtStart, fingerprint(repo));
      if (litter.length) {
        failed++;
        console.error(`\n✗ ${s.name}: ${writers.length} writing tools LITTERED THE WORKING DIRECTORY:`);
        for (const c of litter.slice(0, 15)) console.error(`    ${c}`);
        console.error('  A tool has a store, and the user has a working directory, and they are not');
        console.error('  the same place. Write to yours.');
      } else {
        console.log(`✓ ${s.name}: ${writers.length} writing tools ran, and left the working directory alone`);
      }
    });
  } catch (e) {
    failed++;
    console.error(`✗ ${s.name}: ${e.message}`);
  } finally {
    if (platform) { platform.kill(); await new Promise((r) => platform.once('exit', r)); }
    rmSync(store, { recursive: true, force: true });
  }
}

console.log(`\n${checked} read-only tools called (nothing moved) · ${wrote} writing tools called (no litter).`);
if (failed) { console.error(`${failed} server(s) broke their own promise.`); process.exit(1); }
// AND ZERO IS NOT A PASS.
if (!checked) { console.error('NOTHING WAS CHECKED. That is not a clean bill of health.'); process.exit(1); }
console.log('Every readOnlyHint:true is TRUE.');
