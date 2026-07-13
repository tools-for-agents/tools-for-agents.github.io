#!/usr/bin/env node
// consistent.mjs — DO THE SEVEN REPOS STILL AGREE ON WHAT MUST BE IDENTICAL?
//
// The kit is seven repos that ship as ONE thing, evolving in parallel. That is exactly the shape
// where a fix lands in six and misses the seventh — I have hit it: iris's serveStatic kept the weak
// path guard for a full cycle after the other six were hardened, and the mutants-gate timeout bug
// was latent in all seven copies at once. The behavioural gates (honest / sealed / additive /
// loop / packaged) prove each SERVER does the right thing. Nothing proved the repos still AGREE.
//
// This checks only the invariants that MUST be identical across all seven, with NO legitimate
// exception — so it cannot fire on a deliberate per-repo difference (e.g. the refused-write gate,
// which four write-primary tools have and the three read-primary ones intentionally don't). A
// consistency check that flags an intended difference is the "fires on correct work" trap; this is
// scoped to leave no room for it.
//
//   node build/consistent.mjs --root <dir of the seven checkouts>

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootArg = process.argv.indexOf('--root');
const ROOT = resolve(rootArg >= 0 ? process.argv[rootArg + 1] : '.');
const REPOS = ['agent-hq', 'lens', 'anvil', 'cortex', 'scout', 'recall', 'iris'];

const read = (r, f) => { try { return readFileSync(join(ROOT, r, f), 'utf8'); } catch { return null; } };
const pkg = (r) => { try { return JSON.parse(read(r, 'package.json')); } catch { return null; } };

const problems = [];

// A field that every repo must set to the SAME value. Report the odd ones out against the majority.
function mustAgree(label, valueOf) {
  const vals = {};
  for (const r of REPOS) { const v = valueOf(r); vals[r] = v === undefined ? '(missing)' : String(v); }
  const counts = {};
  for (const v of Object.values(vals)) counts[v] = (counts[v] || 0) + 1;
  const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const odd = REPOS.filter((r) => vals[r] !== majority);
  if (odd.length) {
    problems.push(`${label}: ${odd.map((r) => `${r}=${vals[r]}`).join(', ')} — the other ${REPOS.length - odd.length} say "${majority}"`);
  } else {
    console.log(`✓ ${label}: all seven agree on "${majority}"`);
  }
}

// A file/flag every repo must HAVE. Report the ones missing it.
function mustHave(label, hasIt) {
  const missing = REPOS.filter((r) => !hasIt(r));
  if (missing.length) problems.push(`${label}: MISSING in ${missing.join(', ')}`);
  else console.log(`✓ ${label}: present in all seven`);
}

// ── the invariants ────────────────────────────────────────────────────────────────────────
// 1. Version — the kit tags one release across all seven; a partial bump ships mismatched tarballs.
mustAgree('package version', (r) => pkg(r)?.version);
// 2. Node engine — the published packages promise the same runtime floor.
mustAgree('engines.node', (r) => pkg(r)?.engines?.node);
// 3. mcpName format — the registry namespace ownership marker.
for (const r of REPOS) {
  const name = pkg(r)?.mcpName;
  if (!name || !/^io\.github\.tools-for-agents\//.test(name)) problems.push(`mcpName in ${r}: ${name ?? '(missing)'} — must be io.github.tools-for-agents/<tool>`);
}
if (!problems.some((p) => p.startsWith('mcpName'))) console.log('✓ mcpName: all seven in the io.github.tools-for-agents/* namespace');
// 4. The core files a publishable, gated repo must carry.
mustHave('server.json (registry metadata)', (r) => existsSync(join(ROOT, r, 'server.json')));
mustHave('scripts/mutants.mjs (the canary gate)', (r) => existsSync(join(ROOT, r, 'scripts', 'mutants.mjs')));
mustHave('publish.yml (the release workflow)', (r) => existsSync(join(ROOT, r, '.github', 'workflows', 'publish.yml')));
// 5. The CI gates every repo must run — the ones with no per-repo exception. (refused-write is
//    deliberately NOT here: four write-primary tools have it, three read-primary ones don't.)
for (const gate of ['test', 'mutants', 'look', 'first-run', 'dead-api']) {
  mustHave(`CI gate "${gate}"`, (r) => new RegExp(`^  ${gate}:$`, 'm').test(read(r, '.github/workflows/ci.yml') || ''));
}
// 6. The CI node version — the box the gates run on.
mustAgree('CI node-version', (r) => (read(r, '.github/workflows/ci.yml') || '').match(/node-version: '?(\d+)'?/)?.[1]);
// 7. The shared design tokens + strict — nobody vendors a copy of the design system.
mustHave('tokens: kit (shared design system)', (r) => /tokens: kit/.test(read(r, '.github/workflows/ci.yml') || ''));

console.log('');
if (problems.length) {
  console.error(`✗ the seven repos have drifted apart:\n${problems.map((p) => `  · ${p}`).join('\n')}`);
  console.error('\nA kit that ships as one thing must agree on what is identical. Bring the odd repo back into line.');
  process.exit(1);
}
console.log('All seven repos agree on every shared invariant.');
