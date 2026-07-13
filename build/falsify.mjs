#!/usr/bin/env node
// falsify.mjs — MUTATION TESTING. Break the code on purpose; demand the suite goes red.
//
// A green test suite has proven nothing until you have watched it turn red. This plants one
// small lie in the source at a time, runs the suite, and reports every lie the tests believed
// (a SURVIVOR).
//
// ── WHAT A SURVIVOR IS ────────────────────────────────────────────────────────────────────
// A LEAD. NOT A BUG. The value is not the mutant — it is the code the mutant points AT.
//
//   · lens was indexing .env files and serving credentials back to models. Found by reading
//     the dead code a survivor pointed at.
//   · cortex silently LOST NOTES: two files with the same name in different folders collided
//     on the primary key, and which one survived depended on the alphabetical order of its
//     folder. Found by reading four lines below a survivor in the vault walk.
//
// Neither was the mutant. Both were next to it.
//
// ── HOW IT RELATES TO `scripts/mutants.mjs` ───────────────────────────────────────────────
// This is the EXPLORER: slow, broad, run by hand, finds new leads.
// `scripts/mutants.mjs` (in each of the 7 repos) is the GATE: a small declared list of
// canaries that MUST die, fast enough to run on every push. You use this to find them; that
// one keeps them dead.
//
// ── IT DOES NOT MUTATE INSIDE STRINGS OR REGEX LITERALS ───────────────────────────────────
// The first version did, and it turned /<[^>]+>/ into /<[^>=]+>/. Those are not mutants of
// the LOGIC — they are typos in DATA, and a suite is under no obligation to notice them. They
// survive by the dozen and bury the handful of survivors that mean something. Masking them
// took agent-hq's score from a meaningless 45% to a real 62%.
//
//     A MUTATION SCORE YOU CANNOT TRUST IS WORSE THAN NONE: it tells you the tests are weak
//     when they are not, and you go hunting for bugs that were never there.
//
// ── IT OWNS THE FILES WHILE IT RUNS ───────────────────────────────────────────────────────
// It restores every file it touches, from a snapshot taken at startup — so DO NOT EDIT a file
// it is sweeping. It will silently revert you. (It did, to me, twice.) And if it is killed
// hard it can leave a mutant behind: `git status` after it exits, always.
//
//   node build/falsify.mjs <repo-dir> [--only <file.js>] [--limit N]
//
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { resolve, relative } from 'node:path';

const repo = resolve(process.argv[2]);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const limit = process.argv.includes('--limit') ? +process.argv[process.argv.indexOf('--limit') + 1] : Infinity;

// ---- mutation operators. Each: [name, regex, replacement]. Applied one occurrence at a time.
const OPS = [
  ['!==  → ===', /!==/g, '==='],
  ['===  → !==', /===/g, '!=='],
  ['>=   → >', />=/g, '>'],
  ['<=   → <', /<=/g, '<'],
  ['>    → >=', /(?<![->=<])>(?![=>])/g, '>='],
  ['<    → <=', /(?<![-<=])<(?![=<])/g, '<='],
  ['&&   → ||', /&&/g, '||'],
  ['||   → &&', /(?<!\|)\|\|(?!\|)/g, '&&'],
  ['+    → -', /(?<![+\-=<>!*/%&|^ ]) \+ (?![+=])/g, ' - '],
  ['-    → +', /(?<![+\-=<>!*/%&|^ ]) - (?![-=])/g, ' + '],
  ['true → false', /\btrue\b/g, 'false'],
  ['false→ true', /\bfalse\b/g, 'true'],
  ['0    → 1', /(?<![\w.])0(?![\w.])/g, '1'],
  ['1    → 0', /(?<![\w.])1(?![\w.])/g, '0'],
  ['if(x)→ if(!x)', /\bif \(/g, 'if (!'],
  ['return→ return', /\breturn (?![;}])/g, 'return void '],
];

// lines we must not mutate: they'd break parsing or are not logic
const SKIP_LINE = /^\s*(\/\/|\*|\/\*|import |export \{|const \{[^}]*\} = require)/;

// ── DO NOT MUTATE INSIDE A STRING OR A REGEX LITERAL ──────────────────────────
// The first version did, and it turned `/<[^>]+>/` into `/<[^>=]+>/` and `'0 hits'` into
// `'1 hits'`. Those are not mutants of the LOGIC — they are typos in data, and a suite is
// under no obligation to notice them. They survive by the dozen, inflate the survivor
// count, and bury the handful of survivors that mean something.
//
// A mutation score you cannot trust is worse than none: it tells you the tests are weak
// when they are not, and you go looking for bugs that were never there.
const codeMask = (line) => {
  const mask = new Array(line.length).fill(true);
  let i = 0, q = null;                       // q: the quote/regex char we are inside
  const opens = /[(,=:[!&|?{};+\-*%~^]|^\s*$|\breturn\b|\btypeof\b/;
  while (i < line.length) {
    const c = line[i];
    if (q) {
      mask[i] = false;
      if (c === '\\') { if (i + 1 < line.length) mask[i + 1] = false; i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === '/' && line[i + 1] === '/') { for (let k = i; k < line.length; k++) mask[k] = false; break; }
    if (c === "'" || c === '"' || c === '`') { q = c; mask[i] = false; i++; continue; }
    // a `/` is a regex only where a value may start — otherwise it is division
    if (c === '/' && opens.test(line.slice(0, i).trimEnd().slice(-7))) { q = '/'; mask[i] = false; i++; continue; }
    i++;
  }
  return mask;
};

const files = execSync(`git -C ${repo} ls-files 'src/*.js' 'mcp/*.js' 'scripts/*.js'`, { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
  .filter((f) => !only || f.includes(only));

const dirty = new Map(); // path -> original text
const restore = () => { for (const [p, t] of dirty) writeFileSync(p, t); dirty.clear(); };
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('exit', restore);

const runTests = () => {
  const r = spawnSync('npm', ['test'], { cwd: repo, encoding: 'utf8', timeout: 180_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  // A SKIPPED test is a failed test (cycle 13) — a mutant that only skips tests survived.
  const skipped = +(out.match(/# skip (\d+)/)?.[1] ?? out.match(/skipped (\d+)/)?.[1] ?? 0);
  return { red: r.status !== 0, skipped, out };
};

console.log(`\n### falsify ${relative(process.cwd(), repo)} — ${files.length} files`);

// 0. The suite must be GREEN before we start, or every mutant "dies" for free.
const base = runTests();
if (base.red) { console.log('BASELINE IS RED — nothing to prove here.\n' + base.out.slice(-2000)); process.exit(1); }
console.log(`baseline: green${base.skipped ? `, but ${base.skipped} SKIPPED` : ''}\n`);

let killed = 0, survived = 0, tried = 0;
const survivors = [];

for (const rel of files) {
  const path = resolve(repo, rel);
  const orig = readFileSync(path, 'utf8');
  const lines = orig.split('\n');

  for (let i = 0; i < lines.length && tried < limit; i++) {
    if (SKIP_LINE.test(lines[i]) || !lines[i].trim()) continue;

    const mask = codeMask(lines[i]);

    // ONE mutant per line — the first operator that applies. A full suite run costs
    // seconds; 16 mutants a line buys correlated evidence at 16x the price.
    for (const [name, re, rep] of OPS) {
      re.lastIndex = 0;
      // the first match that lies entirely in CODE — not inside a string or a regex literal
      let m = null;
      for (let x; (x = re.exec(lines[i])) !== null; ) {
        let ok = true;
        for (let k = x.index; k < x.index + x[0].length; k++) if (!mask[k]) { ok = false; break; }
        if (ok) { m = x; break; }
        if (re.lastIndex === x.index) re.lastIndex++;   // zero-width guard
      }
      if (!m) continue;
      const mutatedLine = lines[i].slice(0, m.index) + m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), rep)
        + lines[i].slice(m.index + m[0].length);
      if (mutatedLine === lines[i]) continue;

      const mutant = [...lines.slice(0, i), mutatedLine, ...lines.slice(i + 1)].join('\n');
      dirty.set(path, orig);
      writeFileSync(path, mutant);
      tried++;

      const { red, skipped } = runTests();
      writeFileSync(path, orig); dirty.delete(path);

      if (red) { killed++; process.stdout.write('.'); }
      else {
        survived++;
        process.stdout.write('S');
        survivors.push({ rel, line: i + 1, op: name, was: lines[i].trim(), now: mutatedLine.trim(), skipped });
      }
      break; // one mutant per line
    }
  }
}

console.log(`\n\nkilled ${killed} · SURVIVED ${survived} · tried ${tried}`);
if (survivors.length) {
  console.log('\n─── SURVIVORS (leads, not bugs — read the code each one points at) ───');
  for (const s of survivors) {
    console.log(`\n${s.rel}:${s.line}   [${s.op}]${s.skipped ? `  ⚠ ${s.skipped} skipped` : ''}`);
    console.log(`  was: ${s.was.slice(0, 110)}`);
    console.log(`  now: ${s.now.slice(0, 110)}`);
  }
}
