#!/usr/bin/env node
/**
 * Generates the machine-readable half of this site:
 *
 *   tools.json      every tool, and every MCP tool an agent can actually call
 *   llms.txt        the map an agent reads first        (spec: llmstxt.org)
 *   llms-full.txt   the whole kit in one fetch          (de-facto convention)
 *
 * The tool lists are NOT hand-written. This spawns each MCP server over stdio
 * and asks it `tools/list` — the same handshake a model does. A manifest that
 * is typed by hand is a manifest that is wrong by next Tuesday.
 *
 * Run from the workspace root that holds the seven tool repos:
 *   node build/generate.mjs /path/to/workspace
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.argv[2] || join(OUT, "..");
const SITE = "https://tools-for-agents.github.io";
const GH = "https://github.com/tools-for-agents";
const RAW = "https://raw.githubusercontent.com/tools-for-agents";

/** The kit, in loop order. Everything else is derived. */
const TOOLS = [
  { id: "agent-hq", glyph: "🛰️", verb: "coordinate", color: "#6ea8fe",
    tagline: "The company's work, made visible.",
    blurb: "Shared memory, a kanban board an agent can claim work from, an agent registry, messaging and a cost ledger.",
    use: "Use when more than one agent is working, or when work must outlive a single session." },
  { id: "lens", glyph: "🔎", verb: "read code", color: "#4fd6be",
    tagline: "Read code without reading files.",
    blurb: "Token-efficient retrieval: FTS5 search, symbol outlines and surgical line-range reads.",
    use: "Use INSTEAD of opening whole files. Run `lens index <path>` once, then search." },
  { id: "anvil", glyph: "⚒", verb: "run safely", color: "#ff6a1a",
    tagline: "Run it before you claim it works.",
    blurb: "A throwaway Docker sandbox — network off, memory capped, caps dropped, hard timeout, structured result.",
    use: "Use to execute untrusted or unverified code. Mount a repo read-only at /repo to test it for real." },
  { id: "cortex", glyph: "🧠", verb: "remember", color: "#a78bfa",
    tagline: "A second brain that outlives the context window.",
    blurb: "An Obsidian-compatible vault: markdown notes, [[wikilinks]], a knowledge graph, FTS5 search. Broken links heal themselves.",
    use: "Use to keep what you learned. Files are the truth; the index is rebuildable." },
  { id: "scout", glyph: "🧭", verb: "read the web", color: "#e0a24e",
    tagline: "The web, ~90% lighter.",
    blurb: "A URL becomes clean, cached, full-text-searchable markdown. Re-reads are free; the reading history is a corpus.",
    use: "Use instead of fetching raw HTML into your context." },
  { id: "prism", glyph: "🔻", verb: "read data", color: "#38bdf8", webless: true,
    tagline: "Read data without reading the blob.",
    blurb: "Any JSON or JSONL blob becomes its shape and the slice you asked for — depth-, key-, token- and node-bounded, because it reads untrusted data.",
    use: "Use INSTEAD of pasting a big JSON response into context. `prism shape` first, then `prism read` the paths you need." },
  { id: "recall", glyph: "◎", verb: "recall it all", color: "#ec4899",
    tagline: "One query. Every store you have.",
    blurb: "Federated search across cortex (brain), agent-hq (team), scout (reading) and lens (code) — one token-budgeted briefing.",
    use: "Use FIRST, at the start of a task, before you search anything individually." },
  { id: "iris", glyph: "👁", verb: "see", color: "#c792ea",
    tagline: "Look at what you built.",
    blurb: "Renders your page or game at real viewports and themes and hands the PIXELS back to the model — overflow, clipping, contrast, unreadable type, collisions, dead game loops, design drift.",
    use: "Use after writing or changing ANY interface, BEFORE you say it works. An agent that never looks is designing blind." },
];

/** Speak MCP to a server over stdio and ask what it can do. */
function askServer(dir) {
  return new Promise((resolve) => {
    const p = spawn("node", [join(ROOT, dir, "mcp", "mcp-server.js")], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, HQ_URL: "http://localhost:7700" },
    });
    let buf = "";
    const done = (v) => { try { p.kill("SIGKILL"); } catch {} resolve(v); };
    const timer = setTimeout(() => done([]), 10000);

    p.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          done(msg.result.tools.map((t) => ({
            name: t.name,
            description: (t.description || "").replace(/\s+/g, " ").trim(),
            // What the tool does to the world (MCP tool annotations). An agent reading
            // this manifest should be able to tell a search from a delete WITHOUT
            // calling either of them.
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })));
        }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
    p.on("error", () => { clearTimeout(timer); done([]); });

    const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "tools-for-agents-site-build", version: "1.0.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

/**
 * The port each tool's web view actually runs on.
 *
 * This was hand-typed in the table above, and two of the seven were WRONG — anvil and
 * scout each advertised a port nothing was listening on. Which is the whole thesis of
 * this file arriving to collect: any fact a human types is a fact that is wrong later,
 * and the drift gate cannot catch it, because it is not derived from anything.
 *
 * So derive it from the one place the port is PROVEN: each repo's CI serves the tool on
 * it and then points iris at it. If the port were wrong, that build would already be red.
 */
async function servedPort(id) {
  const ci = await readFile(join(ROOT, id, ".github", "workflows", "ci.yml"), "utf8");
  const m = ci.match(/http:\/\/localhost:(\d+)/);
  if (!m) throw new Error(`${id}: no served URL in ci.yml — cannot publish a port nobody proved`);
  return +m[1];
}

/**
 * NEVER ADVERTISE A COMMAND YOU HAVE NOT VERIFIED.
 *
 * This file was telling agents to run `npx -y @tools-for-agents/lens mcp`, and that
 * package does not exist. It also named an MCP-registry entry that returns zero
 * servers. Both were written the day the server.json files were prepared, as if
 * preparing to publish were the same act as publishing.
 *
 * A manifest for agents that hands out a 404 is worse than one that says nothing: the
 * agent does not get to find out it was lied to until it is already failing.
 *
 * So we ASK. And a check that could not be made is not a pass — if npm is unreachable
 * we say nothing rather than guess, because the safe direction is silence.
 */
async function onNpm(pkg) {
  try {
    const r = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}`,
      { signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return true;
  } catch (e) {
    console.log(`  ! could not reach npm for ${pkg} (${e.message}) — not advertising what I cannot verify`);
    return false;
  }
}

async function inMcpRegistry(name) {
  try {
    const r = await fetch(
      `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    // The registry wraps each entry: { servers: [ { server: {name,…}, _meta:{…} } ] }.
    // Reading `s.name` gets undefined for every row, so the check answers "no" for
    // everything, forever — including after we publish. A verifier that can only ever
    // say no is not a verifier; it is a constant wearing a function's clothes. Caught
    // by asking it about a server that IS published (io.github.06ketan/slideshot) and
    // watching it deny that too.
    return (j.servers || []).some((s) => (s.server?.name ?? s.name) === name);
  } catch (e) {
    console.log(`  ! could not reach the MCP registry (${e.message}) — not claiming an entry I cannot see`);
    return false;
  }
}

const tools = [];
for (const t of TOOLS) {
  const mcpTools = await askServer(t.id);
  const pkg = JSON.parse(await readFile(join(ROOT, t.id, "package.json"), "utf8"));
  // Most tools ship a web view and PROVE its port in CI; a CLI+MCP-only tool (prism) has none, and
  // must not be made to advertise a port nobody serves. servedPort stays strict for the rest.
  t.port = t.webless ? null : await servedPort(t.id);
  // A server that fails to answer returns [] — and an empty list is not a fact, it is a
  // failed handshake wearing the costume of one. Publishing "lens: 0 tools" because a
  // spawn died is worse than publishing nothing: it is a confident, wrong answer.
  if (mcpTools.length === 0) {
    throw new Error(`${t.id}: the MCP server answered with no tools. That is a broken handshake, `
      + `not a tool with nothing to offer — refusing to write a manifest that says so.`);
  }
  const onNpmNow = await onNpm(pkg.name);
  const registryName = `io.github.tools-for-agents/${t.id}`;
  const inRegistryNow = await inMcpRegistry(registryName);
  console.log(`  ${t.glyph} ${t.id.padEnd(9)} ${String(mcpTools.length).padStart(2)} MCP tools`
    + `   npm:${onNpmNow ? "yes" : "no "}  mcp-registry:${inRegistryNow ? "yes" : "no "}`);
  tools.push({ ...t, package: pkg.name, version: pkg.version, mcpTools,
    onNpm: onNpmNow, registryName, inRegistry: inRegistryNow });
}

const total = tools.reduce((n, t) => n + t.mcpTools.length, 0);
console.log(`  ${"".padEnd(11)} ${total} total\n`);

// The COUNT of tools is derived (tools.length); the WORD "seven" scattered through the prose below
// was NOT — and this file's whole thesis is that a hand-typed fact is wrong by next Tuesday (it drifted
// from six to seven once already). Derive the word too, so adding a tool never leaves a stale count behind.
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const countWord = NUM[tools.length] || String(tools.length);
const Countword = countWord[0].toUpperCase() + countWord.slice(1);

/* ── tools.json ─────────────────────────────────────────────────────────── */
const manifest = {
  $comment: [
    "A machine-readable index of the tools-for-agents kit, for agents.",
    "This is OUR format, not a ratified standard — there isn't one yet.",
    "The standards-backed entry points are /llms.txt (llmstxt.org) and the",
    "official MCP registry (registry.modelcontextprotocol.io).",
    "Generated by build/generate.mjs, by asking each MCP server tools/list.",
  ],
  name: "tools-for-agents",
  description: `An operating system for agents: ${countWord} zero-dependency, MCP-native tools that form one loop.`,
  homepage: SITE,
  github: GH,
  license: "MIT",
  toolCount: tools.length,
  mcpToolCount: total,
  loop: tools.map((t) => t.verb),
  install: {
    note: "Zero dependencies. Node 22+ (needs built-in node:sqlite). Clone, then register the MCP servers.",
    clone: tools.map((t) => `git clone ${GH}/${t.id}.git`),
    claudeCode: tools.map((t) => `claude mcp add ${t.id} -s user -- node $PWD/${t.id}/mcp/mcp-server.js`),
    mcpJson: {
      mcpServers: Object.fromEntries(tools.map((t) => [
        t.id, { command: "node", args: [`/absolute/path/to/${t.id}/mcp/mcp-server.js`] },
      ])),
    },
  },
  // What a tool owes an agent. A model cannot see the screen, cannot check the
  // filesystem, and cannot tell that a tool was misconfigured — it has only what the tool
  // said. So the one thing a tool must never do is sound sure. Each of these is enforced
  // by a gate that has been WATCHED TO FAIL; a gate nobody has seen fail is a gate you are
  // trusting on faith.
  guarantees: {
    neverAConfidentWrongAnswer:
      "An empty result carries the size of the haystack. '0 hits of 0 notes' is a misconfigured path; "
      + "'0 hits of 500 notes' is a real answer. 'Nothing is indexed' and 'your code does not contain that' "
      + "are the same sentence to a caller, and could not be more different.",
    aTypoIsNotAnEmptySet:
      "Columns, agents and namespaces are finite, known sets. A filter naming something outside the set is a "
      + "MISTAKE, not a query with no results — and the error lists the values that do exist.",
    aReadCreatesNothing:
      "Ask a question in any directory and nothing is left behind. Opening a store used to create it, so the "
      + "empty store the tool had just made then answered the question — the tool invented the evidence for its own answer.",
    everyErrorIsActionable:
      "'fetch failed' is not an error message. Every error names what went wrong, where it looked, and the command that fixes it.",
    everyToolDeclaresWhatItDoes:
      "MCP tool annotations on all " + total + ": " + tools.reduce((n, t) => n + t.mcpTools.filter((m) => m.annotations?.readOnlyHint).length, 0)
      + " read-only, " + tools.reduce((n, t) => n + t.mcpTools.filter((m) => m.annotations?.destructiveHint).length, 0)
      + " destructive, " + tools.reduce((n, t) => n + t.mcpTools.filter((m) => m.annotations?.openWorldHint).length, 0)
      + " open-world. A client can tell a search from a delete without calling either.",
    everyClaimIsGated:
      "The whole loop runs on every push from fresh clones; all " + total + " tools are called; the UI is looked at "
      + "with data ugly enough to break it; a skipped test is a failed test.",
  },
  // Say where things actually stand, rather than leaving an agent to discover it by
  // running a command that fails. Checked against npm and the MCP registry at build
  // time — this block is derived, not asserted.
  publication: {
    npm: {
      published: tools.every((t) => t.onNpm),
      scope: "@tools-for-agents",
      note: tools.every((t) => t.onNpm)
        ? "Every tool is on npm; `npx` is in each tool's mcpServer block."
        : "NOT on npm yet. Install from source (see `install`) — an `npx` command appears here only once npm answers for the package.",
    },
    mcpRegistry: {
      published: tools.every((t) => t.inRegistry),
      namespace: "io.github.tools-for-agents/*",
      note: tools.every((t) => t.inRegistry)
        ? "Every tool is in the official MCP registry."
        : "NOT in the registry yet. A `server.json` is committed in every repo and validated against the live schema; publishing needs an npm release first, since the registry hosts metadata only.",
    },
  },
  tools: tools.map((t) => ({
    id: t.id,
    verb: t.verb,
    tagline: t.tagline,
    description: t.blurb,
    whenToUse: t.use,
    repository: `${GH}/${t.id}`,
    readme: `${RAW}/${t.id}/main/README.md`,
    version: t.version,
    // Only stated when it is TRUE. `npx @tools-for-agents/lens` was advertised here
    // while the package 404'd, and an MCP-registry name was given for an entry that
    // returned zero servers — because the server.json files had been *prepared*, and
    // preparing to publish is not publishing.
    ...(t.onNpm ? { npmPackage: t.package } : {}),
    ...(t.inRegistry ? { mcpRegistryName: t.registryName } : {}),
    mcpServer: {
      transport: "stdio",
      // This works today, from a clone. It is the only install we can stand behind.
      command: "node",
      args: [`${t.id}/mcp/mcp-server.js`],
      // `npx <pkg>` runs the bin named after the package — which for the six CLI tools
      // is the CLI — so the server is reached through its `mcp` subcommand. Emitted
      // only once npm actually answers for the package.
      ...(t.onNpm ? {
        npx: t.id === "agent-hq"
          ? ["npx", "-y", t.package]
          : ["npx", "-y", t.package, "mcp"],
      } : {}),
    },
    ...(t.port ? { webView: { command: `${t.id} serve`, url: `http://localhost:${t.port}` } } : {}),
    mcpTools: t.mcpTools,
  })),
};
await writeFile(join(OUT, "tools.json"), JSON.stringify(manifest, null, 2) + "\n");

/* ── llms.txt ───────────────────────────────────────────────────────────── */
// Spec (llmstxt.org): H1 (the only required section), a blockquote summary,
// free-form prose, then H2 "file list" sections. "## Optional" may be skipped
// by a reader on a short context budget.
const llms = `# tools-for-agents

> An operating system for agents: ${countWord} zero-dependency, MCP-native tools that form one loop — coordinate, read code, run safely, remember, read the web, read data, recall, and see. Every tool speaks MCP over stdio and runs locally. ${total} callable MCP tools in total.

If you are an agent, start with [tools.json](${SITE}/tools.json): one fetch gives you every tool, its install command, and the name and description of all ${total} MCP tools you can call — without cloning anything.

The kit is one loop. \`recall\` at the start of a task, \`lens\` to read code instead of opening files, \`anvil\` to run anything you have not verified, \`cortex\` to keep what you learned, \`scout\` to read the web, \`prism\` to see the shape of a JSON blob instead of pasting it whole, \`agent-hq\` to coordinate with other agents, and \`iris\` to look at what you built before claiming it works.

Requirements: Node 22+ (built-in \`node:sqlite\`), Docker for \`anvil\`, Chrome for \`iris\`. Nothing to \`npm install\` — every tool has zero runtime dependencies.

## The ${countWord} tools

${tools.map((t) => `- [${t.id}](${RAW}/${t.id}/main/README.md): ${t.verb} — ${t.blurb} ${t.mcpTools.length} MCP tools: \`${t.mcpTools.map((m) => m.name).join("`, `")}\`.`).join("\n")}

## What these tools guarantee

A model cannot see your screen, cannot check your filesystem, and cannot tell that a tool was misconfigured. It has only what the tool said. So the one thing a tool must never do is **sound sure**.

- **Never a confident wrong answer.** An empty result carries the size of the haystack: \`0 hits of 0 notes\` is a misconfigured path, \`0 hits of 500 notes\` is a real answer. *"Nothing is indexed"* and *"your code does not contain that"* are the same sentence to a caller, and could not be more different.
- **A typo is not an empty set.** Columns, agents and namespaces are finite, known sets — a filter naming something outside the set is a mistake, and the error lists the values that do exist.
- **A read creates nothing.** Ask a question in any directory and nothing is left behind.
- **Every error is actionable** — it names what went wrong, where it looked, and the command that fixes it.
- **Every tool declares what it does to the world** (MCP annotations), so a client can tell a search from a delete without calling either.
- **Every claim is gated**, and every gate has been watched to fail.

## Machine-readable

- [tools.json](${SITE}/tools.json): every tool and every callable MCP tool, as JSON. Start here.
- [llms-full.txt](${SITE}/llms-full.txt): the full README of all ${countWord} tools, concatenated into one fetch.

## Source

${tools.map((t) => `- [${t.id} on GitHub](${GH}/${t.id}): ${t.tagline}`).join("\n")}
- [the organisation](${GH}): all ${countWord} repositories, MIT, CI-green, gated by iris.

## Optional

- [the design system](${RAW}/iris/main/tokens.json): the type scale, spacing grid, radii and contrast floor every tool in the kit obeys. \`iris look --tokens\` enforces it.
- [the landing page](${SITE}): the human-facing version of this file.
`;
await writeFile(join(OUT, "llms.txt"), llms);

/* ── llms-full.txt ──────────────────────────────────────────────────────── */
const readmes = [];
for (const t of tools) {
  readmes.push(`\n\n${"=".repeat(78)}\n# ${t.id} — ${t.verb}\n# ${GH}/${t.id}\n${"=".repeat(78)}\n\n` +
    (await readFile(join(ROOT, t.id, "README.md"), "utf8")).trim());
}
await writeFile(join(OUT, "llms-full.txt"),
  `# tools-for-agents — the complete kit\n\n` +
  `> ${Countword} zero-dependency, MCP-native tools that form one agent loop. ${total} callable MCP tools.\n` +
  `> This file is every tool's README, concatenated, so a model can ingest the whole kit in one fetch.\n` +
  `> Curated index: ${SITE}/llms.txt · Machine-readable: ${SITE}/tools.json\n` +
  readmes.join("") + "\n");

// The landing page states the tool count in prose ("All 67 MCP tools…") — and one of those very
// sentences claims the manifest "cannot drift". The claim was true of tools.json and a lie about the
// number sitting next to it: index.html is hand-written, so every tool added drifted it. Derive it
// here too. Rewrite every "<n> MCP tools" / "<n> tools registered" / "All <n> tools" to the real
// count, so the page cannot say a number the servers disagree with.
try {
  const idx = join(OUT, "index.html");
  const before = await readFile(idx, "utf8");
  const after = before
    .replace(/\b\d+ MCP tools\b/g, `${total} MCP tools`)
    .replace(/\b\d+ tools registered\b/g, `${total} tools registered`)
    .replace(/\ball \d+ tools\b/gi, (m) => m.replace(/\d+/, total));
  if (after !== before) { await writeFile(idx, after); console.log(`  index.html: tool count → ${total}`); }
} catch { /* no index.html in this checkout — the manifest files above are the source of truth */ }

console.log(`✓ tools.json · llms.txt · llms-full.txt  (${tools.length} tools, ${total} MCP tools)`);
