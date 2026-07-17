#!/usr/bin/env node
// packaged.mjs — DOES THE PACKAGE WE WOULD PUBLISH ACTUALLY WORK?
//
// The manifest job already handshakes each server from a fresh CLONE. But a clone is not what an
// agent installs — a clone has every file in git; a PUBLISHED PACKAGE has only what package.json's
// `files` field lets npm include. Drop `mcp` or `src` from that list and the clone test stays
// green while `npx @tools-for-agents/<tool>` installs a package with no server in it.
//
//     A FRESH CLONE IS NOT A FRESH INSTALL. THE ONLY ARTIFACT WHOSE OPINION COUNTS IS THE TARBALL.
//
// So this does the whole round trip, exactly as a user does: `npm pack` each repo → install the
// tarball into a clean throwaway dir → run the PUBLISHED BIN (the one server.json points npx at) →
// initialize + tools/list over stdio → demand real tools back on a clean stdout stream.
//
//   node build/packaged.mjs --root <dir of the seven checkouts>

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const rootArg = process.argv.indexOf('--root');
const ROOT = resolve(rootArg >= 0 ? process.argv[rootArg + 1] : '.');
const ONLY = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--root');

const REPOS = ['agent-hq', 'lens', 'anvil', 'cortex', 'scout', 'prism', 'recall', 'iris'];

// The published command: `npx <pkg> [mcp]`. All the CLI tools give the bin an `mcp` subcommand;
// agent-hq's bin IS the MCP server, so it takes no subcommand. We derive this from package.json +
// server.json rather than hardcode it — if a repo changes how it launches, this follows.
function launchArgs(repo) {
  const pkg = JSON.parse(readFileSync(join(ROOT, repo, 'package.json'), 'utf8'));
  const binName = Object.keys(pkg.bin || {})[0];
  let sub = [];
  try {
    const sj = JSON.parse(readFileSync(join(ROOT, repo, 'server.json'), 'utf8'));
    const pa = sj.packages?.[0]?.packageArguments || [];
    sub = pa.filter((a) => a.type === 'positional' && a.value).map((a) => a.value);
  } catch { /* no server.json → no args */ }
  return { binName, sub };
}

async function handshake(binPath, args) {
  return new Promise((res) => {
    const child = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', spawnErr = null;
    child.on('error', (e) => { spawnErr = e.message; });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaged', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    setTimeout(() => {
      child.kill();
      const lines = out.trim().split('\n').filter(Boolean);
      let tools = 0, desync = null;
      for (const l of lines) { try { const m = JSON.parse(l); if (m.id === 2) tools = m.result?.tools?.length ?? 0; } catch { desync = l.slice(0, 60); } }
      res({ tools, desync, spawnErr, err });
    }, 4000);
  });
}

let failed = 0, checked = 0;
for (const repo of REPOS) {
  if (ONLY.length && !ONLY.includes(repo)) continue;
  const src = join(ROOT, repo);
  if (!existsSync(join(src, 'package.json'))) { failed++; console.error(`✗ ${repo}: no package.json at ${src}`); continue; }

  const work = mkdtempSync(join(tmpdir(), `packaged-${repo}-`));
  try {
    // pack the repo exactly as `npm publish` would bundle it (honours the `files` field)
    const pack = spawnSync('npm', ['pack', '--pack-destination', work], { cwd: src, encoding: 'utf8' });
    if (pack.status !== 0) { failed++; console.error(`✗ ${repo}: npm pack failed — ${(pack.stderr || '').slice(0, 120)}`); continue; }
    const tarball = pack.stdout.trim().split('\n').pop().trim();

    // install the tarball into a clean dir — no source, only what the package shipped
    spawnSync('npm', ['init', '-y'], { cwd: work, encoding: 'utf8' });
    const inst = spawnSync('npm', ['install', join(work, tarball)], { cwd: work, encoding: 'utf8' });
    if (inst.status !== 0) { failed++; console.error(`✗ ${repo}: installing the tarball failed — ${(inst.stderr || '').slice(0, 120)}`); continue; }

    const { binName, sub } = launchArgs(repo);
    const binPath = join(work, 'node_modules', '.bin', binName);
    if (!existsSync(binPath)) {
      failed++;
      console.error(`✗ ${repo}: the package installed but its bin '${binName}' is not there — check package.json "bin" and "files".`);
      continue;
    }

    const r = await handshake(binPath, sub);
    checked++;
    if (r.spawnErr) { failed++; console.error(`✗ ${repo}: the published bin would not start — ${r.spawnErr}`); }
    else if (r.desync) { failed++; console.error(`✗ ${repo}: stdout is not clean JSON-RPC (${JSON.stringify(r.desync)}) — a stray print corrupts every session`); }
    else if (r.tools === 0) { failed++; console.error(`✗ ${repo}: the published package handshakes but lists ZERO tools — a file it needs is missing from the tarball. ${r.err.slice(0, 80)}`); }
    else { console.log(`✓ ${repo}: packed, installed clean, and \`${binName}${sub.length ? ' ' + sub.join(' ') : ''}\` served ${r.tools} tools`); }
  } catch (e) {
    failed++; console.error(`✗ ${repo}: ${e.message}`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

console.log(`\n${checked} published packages installed and handshaken.`);
if (failed) { console.error(`${failed} package(s) would not work as published.`); process.exit(1); }
if (!checked) { console.error('NOTHING WAS CHECKED — not a clean bill of health.'); process.exit(1); }
console.log('Every published package installs clean and serves its tools.');
