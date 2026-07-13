#!/usr/bin/env node
// sealed.mjs — IS `openWorldHint: false` TRUE?
//
// The companion to honest.mjs. That one asks whether a tool that says it does not WRITE really
// does not write. This one asks whether a tool that says it does not REACH THE OUTSIDE WORLD
// really does not reach it.
//
// Of the 70 tools, 10 declare `openWorldHint: true` — they talk to the internet, and the client
// is told so. The other 57 say, by declaring `openWorldHint: false`, that they do NOT. That is a
// promise about where your data can go: a "closed" tool that quietly fetches a URL is an
// exfiltration path with a reassuring label on it.
//
//     A TOOL THAT SAYS IT STAYS HOME MUST STAY HOME.
//
// ── THE BLOCK MUST BE PROVEN TO BLOCK ───────────────────────────────────────────────────────
// A network check that is not actually blocking the network is a check that cannot fail — it
// would bless every tool in the kit, including the ones that spend all day on the internet.
// (I have now shipped that mistake three times in honest.mjs alone.)
//
// So this runs in TWO halves, and the first one is the important one:
//
//   1. Call a tool that GENUINELY NEEDS the network (scout_fetch, openWorldHint: true).
//      IT MUST FAIL. If it succeeds, the block is not blocking, nothing below means anything,
//      and this exits non-zero saying so.
//   2. Only then: call every openWorldHint:false tool. None of them may fail on the network.
//
// ── LOCALHOST IS NOT THE OPEN WORLD ─────────────────────────────────────────────────────────
// agent-hq's 28 tools are a skin over its own HTTP API on localhost. A call to a server on your
// own machine is not "interacting with external entities" — it is this program talking to
// itself. So the block allows loopback and refuses everything else, which is exactly the
// question the annotation is asking.

import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const rootArg = process.argv.indexOf('--root');
const ROOT = resolve(rootArg >= 0 ? process.argv[rootArg + 1] : '.');
const ONLY = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--root');

// ── the wall ────────────────────────────────────────────────────────────────────────────────
// Preloaded into every MCP server we start. Anything leaving this machine dies here.
const WALL = `
// An ESM namespace object is FROZEN — \`import('node:dns')\` hands back something you cannot
// assign to, and my first wall died on that line. createRequire gives the CJS exports object,
// which is mutable, and is the same module underneath.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const LOCAL = /^(localhost|127\\.|\\[::1\\]|::1|0\\.0\\.0\\.0)$|^127\\./i;
const isLocal = (h) => !h || LOCAL.test(String(h));
const blocked = (where, target) =>
  Object.assign(new Error('SEALED: this tool reached the open world (' + where + ' -> ' + target + ')'),
    { code: 'ESEALED' });

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let host = '';
  try { host = new URL(typeof input === 'string' ? input : input.url).hostname; } catch {}
  if (!isLocal(host)) return Promise.reject(blocked('fetch', host || String(input).slice(0, 60)));
  return realFetch(input, init);
};

const dns = require('node:dns');
for (const m of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const real = dns[m];
  if (typeof real !== 'function') continue;
  dns[m] = (host, ...rest) => {
    const cb = rest[rest.length - 1];
    if (!isLocal(host) && typeof cb === 'function') return cb(blocked('dns.' + m, host));
    return real(host, ...rest);
  };
}

const net = require('node:net');
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  const host = typeof o === 'object' && o ? (o.host || o.path) : args[1];
  if (!isLocal(host)) throw blocked('net.connect', host);
  return realConnect.apply(this, args);
};
`;

const SERVERS = [
  { name: 'lens',     env: (d) => ({ LENS_DB: join(d, 'code.db') }),
    setup: (r, e) => sh('node', ['src/cli.js', 'index', 'src'], r, e) },
  { name: 'cortex',   env: (d) => ({ CORTEX_VAULT: join(d, 'vault') }),
    setup: (r, e) => sh('node', ['scripts/seed.js'], r, e) },
  { name: 'scout',    env: (d) => ({ SCOUT_DB: join(d, 'cache.db') }),
    setup: (r, e) => sh('node', ['scripts/seed.js'], r, e),
    // scout_fetch is openWorldHint:true and genuinely needs the internet. It is the PROOF that
    // the wall is standing. Without a tool that MUST fail, this whole check cannot fail.
    proof: { tool: 'scout_fetch', args: { url: 'https://example.com/sealed-probe' } } },
  { name: 'anvil',    env: (d) => ({ ANVIL_DB: join(d, 'runs.db') }),
    setup: (r, e) => sh('node', ['scripts/seed.js'], r, e) },
  { name: 'recall',   env: (d) => ({ RECALL_CORTEX_DB: join(d, 'seed/brain.db'), RECALL_SCOUT_DB: join(d, 'seed/reading.db'), RECALL_LENS_DB: join(d, 'seed/code.db') }),
    setup: (r, e, s) => sh('node', ['scripts/seed.js', join(s, 'seed')], r, e) },
  { name: 'iris',     env: (d) => ({ IRIS_OUT: join(d, 'iris') }),
    setup: (r, e) => sh('node', ['src/cli.js', 'look', 'test/fixtures/clean.html', '--viewports', 'desktop', '--themes', 'dark'], r, e) },
  { name: 'agent-hq', env: (d) => ({ HQ_DB_PATH: join(d, 'hq.db'), HQ_URL: 'http://localhost:7789', PORT: '7789' }),
    http: true, setup: (r, e) => sh('node', ['scripts/seed.js'], r, e) },
];

function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180_000 });
  return (r.stdout || '').trim();
}

async function withServer(repo, env, wallFile, fn) {
  const proc = spawn('node', ['--import', `file://${wallFile}`, 'mcp/mcp-server.js'], {
    cwd: repo, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sealed', version: '1' } });
    return await fn(call);
  } finally { proc.stdin.end(); proc.kill(); }
}

function argsFor(tool) {
  const s = tool.inputSchema || {}, props = s.properties || {}, a = {};
  for (const k of s.required || []) {
    const p = props[k] || {};
    if (p.enum?.length) a[k] = p.enum[0];
    else if (p.type === 'number' || p.type === 'integer') a[k] = 1;
    else if (p.type === 'boolean') a[k] = false;
    else if (p.type === 'array') a[k] = [];
    else if (p.type === 'object') a[k] = {};
    else if (/url/i.test(k)) a[k] = 'https://example.com/';
    else if (/path|dir|file/i.test(k)) a[k] = '.';
    else a[k] = 'sealed';
  }
  return a;
}

const said = (r) => JSON.stringify(r?.result ?? r?.error ?? {});
const leaked = (r) => /SEALED:/.test(said(r));

const wallFile = join(mkdtempSync(join(tmpdir(), 'sealed-wall-')), 'wall.mjs');
writeFileSync(wallFile, WALL);

let failed = 0, checked = 0, proofs = 0;
for (const s of SERVERS) {
  if (ONLY.length && !ONLY.includes(s.name)) continue;
  const repo = resolve(ROOT, s.name);
  if (!existsSync(join(repo, 'mcp', 'mcp-server.js'))) {
    failed++; console.error(`✗ ${s.name}: no MCP server at ${repo} — I cannot check what I cannot find`);
    continue;
  }
  const store = mkdtempSync(join(tmpdir(), `sealed-${s.name}-`));
  const env = s.env(store);
  let platform = null;
  if (s.http) {
    platform = spawn('node', ['src/server.js'], { cwd: repo, env: { ...process.env, ...env }, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${env.HQ_URL}/api/health`); if (r.ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    s.setup?.(repo, env, store);
    await withServer(repo, env, wallFile, async (call) => {
      const tools = (await call('tools/list', {})).result?.tools || [];

      // ── 1. PROVE THE WALL IS STANDING ────────────────────────────────────────────────────
      if (s.proof) {
        const r = await call('tools/call', { name: s.proof.tool, arguments: s.proof.args });
        if (!leaked(r)) {
          failed++;
          console.error(`✗ ${s.name}: THE WALL IS NOT STANDING. ${s.proof.tool} is openWorldHint:true and`);
          console.error('  reaches the internet by definition — it should have been blocked and was not.');
          console.error(`  Nothing below this line means anything. It said: ${said(r).slice(0, 140)}`);
          return;
        }
        proofs++;
        console.log(`  · wall proven: ${s.proof.tool} (openWorldHint:true) was stopped at the border`);
      }

      // ── 2. now the closed-world tools must survive it ────────────────────────────────────
      const closed = tools.filter((t) => t.annotations?.openWorldHint !== true);
      const escapees = [];
      for (const t of closed) {
        const r = await call('tools/call', { name: t.name, arguments: argsFor(t) });
        checked++;
        if (leaked(r)) escapees.push(`${t.name} — ${(said(r).match(/SEALED: [^"\\]+/) || [''])[0]}`);
      }
      if (escapees.length) {
        failed++;
        console.error(`\n✗ ${s.name}: ${escapees.length} tool(s) declare openWorldHint:false AND WENT OUTSIDE:`);
        for (const e of escapees) console.error(`    ${e}`);
        console.error('  A tool that says it stays home must stay home. This is an exfiltration path');
        console.error('  with a reassuring label on it.');
      } else {
        console.log(`✓ ${s.name}: ${closed.length} closed-world tools ran, and not one of them left the machine`);
      }
    });
  } catch (e) {
    failed++; console.error(`✗ ${s.name}: ${e.message}`);
  } finally {
    if (platform) { platform.kill(); await new Promise((r) => platform.once('exit', r)); }
    rmSync(store, { recursive: true, force: true });
  }
}

console.log(`\n${checked} closed-world tools called; the wall was proven ${proofs}×.`);
if (failed) { console.error(`${failed} server(s) broke their own promise.`); process.exit(1); }
if (!checked || !proofs) {
  console.error('NOTHING WAS PROVEN. A network check that never blocked anything, or never called');
  console.error('anything, is not a clean bill of health — it is an empty room.');
  process.exit(1);
}
console.log('Every openWorldHint:false stayed home.');
