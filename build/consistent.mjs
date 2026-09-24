#!/usr/bin/env node
// consistent.mjs — DO THE REPOS STILL AGREE ON WHAT MUST BE IDENTICAL?
//
// The kit is eight repos that ship as ONE thing, evolving in parallel. That is exactly the shape
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
const REPOS = ['agent-hq', 'lens', 'anvil', 'keep', 'cortex', 'scout', 'prism', 'recall', 'iris'];
// A tool with NO web view, on purpose, and on the record here rather than by omission: keep holds
// secrets, and a page that lists secrets is a page that can leak them. The UI gates (`look`,
// `dead-api`, the shared design tokens) have nothing to look at; every other invariant applies.
const WEBLESS = ['keep'];
const WEB = REPOS.filter((r) => !WEBLESS.includes(r));
// A companion ships in the kit without being an MCP server, so the MCP- and web-shaped
// invariants below genuinely do not apply to it. The rest do, and used to be skipped by
// accident rather than on purpose: `ghost` was public, in the org, and silently exempt from
// every shared bar because it was not in this list. "Not a tool" is not "not held to anything".
const COMPANIONS = ['ghost'];
const ALL = [...REPOS, ...COMPANIONS];

const read = (r, f) => { try { return readFileSync(join(ROOT, r, f), 'utf8'); } catch { return null; } };
const pkg = (r) => { try { return JSON.parse(read(r, 'package.json')); } catch { return null; } };

const problems = [];

// A field that every repo must set to the SAME value. Report the odd ones out against the majority.
function mustAgree(label, valueOf, who = ALL) {
  const vals = {};
  for (const r of who) { const v = valueOf(r); vals[r] = v === undefined ? '(missing)' : String(v); }
  const counts = {};
  for (const v of Object.values(vals)) counts[v] = (counts[v] || 0) + 1;
  const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const odd = who.filter((r) => vals[r] !== majority);
  if (odd.length) {
    problems.push(`${label}: ${odd.map((r) => `${r}=${vals[r]}`).join(', ')} — the other ${who.length - odd.length} say "${majority}"`);
  } else {
    console.log(`✓ ${label}: all ${who.length} agree on "${majority}"`);
  }
}

// A file/flag every repo must HAVE. Report the ones missing it.
function mustHave(label, hasIt, who = ALL) {
  const missing = who.filter((r) => !hasIt(r));
  if (missing.length) problems.push(`${label}: MISSING in ${missing.join(', ')}`);
  else console.log(`✓ ${label}: present in all ${who.length}`);
}

// ── the invariants ────────────────────────────────────────────────────────────────────────
// 1. Version — the kit tags one release across all seven; a partial bump ships mismatched tarballs.
mustAgree('package version', (r) => pkg(r)?.version);
// 2. Node engine — the published packages promise the same runtime floor.
mustAgree('engines.node', (r) => pkg(r)?.engines?.node);
// 3. mcpName format — the registry namespace ownership marker. TOOLS ONLY: a companion has no
//    MCP server, so claiming a server name for it would be the confident-wrong-answer bug again.
for (const r of REPOS) {
  const name = pkg(r)?.mcpName;
  if (!name || !/^io\.github\.tools-for-agents\//.test(name)) problems.push(`mcpName in ${r}: ${name ?? '(missing)'} — must be io.github.tools-for-agents/<tool>`);
}
if (!problems.some((p) => p.startsWith('mcpName'))) console.log(`✓ mcpName: all ${REPOS.length} in the io.github.tools-for-agents/* namespace`);
// 4. The core files a publishable, gated repo must carry.
mustHave('server.json (registry metadata)', (r) => existsSync(join(ROOT, r, 'server.json')), REPOS);
mustHave('publish.yml (the release workflow)', (r) => existsSync(join(ROOT, r, '.github', 'workflows', 'publish.yml')), REPOS);
// The canary gate is the one thing NOTHING here is exempt from. Every other check asks whether
// a repo is right; this asks whether anything is still watching — and a companion whose suite
// stopped watching fails in exactly the same silence as a tool's.
mustHave('scripts/mutants.mjs (the canary gate)', (r) => existsSync(join(ROOT, r, 'scripts', 'mutants.mjs')));
// 5. The CI gates every repo must run — the ones with no per-repo exception. (refused-write is
//    deliberately NOT here: four write-primary tools have it, three read-primary ones don't.)
const hasGate = (gate) => (r) => new RegExp(`^  ${gate}:$`, 'm').test(read(r, '.github/workflows/ci.yml') || '');
// Every repo in the kit, companion or not, runs its suite, proves the suite can still fail, and
// proves a stranger's first install works.
for (const gate of ['test', 'mutants', 'first-run']) mustHave(`CI gate "${gate}"`, hasGate(gate));
// TOOLS ONLY: `look` needs a web view to look at and `dead-api` an MCP surface to sweep.
for (const gate of ['look', 'dead-api']) mustHave(`CI gate "${gate}"`, hasGate(gate), WEB);
// 6. The CI node version — the box the gates run on.
mustAgree('CI node-version', (r) => (read(r, '.github/workflows/ci.yml') || '').match(/node-version: '?(\d+)'?/)?.[1]);
// 7. The shared design tokens + strict — nobody vendors a copy of the design system.
// TOOLS ONLY: a companion with no interface has no design system to drift from.
mustHave('tokens: kit (shared design system)', (r) => /tokens: kit/.test(read(r, '.github/workflows/ci.yml') || ''), WEB);

// 8. AND THE CHECKS THEMSELVES MUST COVER EVERY REPO.
//
// Three times in one evening the same bug: a repo missing from a list, and therefore silently
// exempt from a gate. ghost was public and held to none of these invariants because it was not
// in REPOS. prism — whose whole job is parsing UNTRUSTED blobs — had never once been through the
// read-only gate, because it was not in that gate's server table, and nothing anywhere said so.
//
// A skipped repo and a passing repo print the same nothing. So the tables are themselves an
// invariant: every tool must appear in every behavioural gate, either as a row that runs or as
// a `skip:` with a reason. An exemption on the record is a decision. An exemption by omission is
// an accident that lasts until someone happens to look.
for (const gate of ['honest', 'sealed', 'additive', 'idempotent']) {
  const src = (() => { try { return readFileSync(new URL(`./${gate}.mjs`, import.meta.url), 'utf8'); } catch { return null; } })();
  if (src === null) { problems.push(`gate coverage: build/${gate}.mjs is missing — a gate nobody can run covers nothing`); continue; }
  const listed = REPOS.filter((r) => new RegExp(`name: '${r}'`).test(src));
  const absent = REPOS.filter((r) => !listed.includes(r));
  if (absent.length) {
    problems.push(`gate coverage: ${gate}.mjs never mentions ${absent.join(', ')} — add a row, or a skip: saying why not`);
  } else {
    console.log(`✓ gate coverage: ${gate}.mjs accounts for all ${REPOS.length} tools`);
  }
}

console.log('');
if (problems.length) {
  console.error(`✗ the kit's repos have drifted apart:\n${problems.map((p) => `  · ${p}`).join('\n')}`);
  console.error('\nA kit that ships as one thing must agree on what is identical. Bring the odd repo back into line.');
  process.exit(1);
}
console.log(`All ${ALL.length} repos agree on every shared invariant (${REPOS.length} tools + ${COMPANIONS.length} companion).`);
