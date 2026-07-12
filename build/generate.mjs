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

const tools = [];
for (const t of TOOLS) {
  const mcpTools = await askServer(t.id);
  const pkg = JSON.parse(await readFile(join(ROOT, t.id, "package.json"), "utf8"));
  t.port = await servedPort(t.id);
  // A server that fails to answer returns [] — and an empty list is not a fact, it is a
  // failed handshake wearing the costume of one. Publishing "lens: 0 tools" because a
  // spawn died is worse than publishing nothing: it is a confident, wrong answer.
  if (mcpTools.length === 0) {
    throw new Error(`${t.id}: the MCP server answered with no tools. That is a broken handshake, `
      + `not a tool with nothing to offer — refusing to write a manifest that says so.`);
  }
  console.log(`  ${t.glyph} ${t.id.padEnd(9)} ${String(mcpTools.length).padStart(2)} MCP tools`);
  tools.push({ ...t, package: pkg.name, version: pkg.version, mcpTools });
}

const total = tools.reduce((n, t) => n + t.mcpTools.length, 0);
console.log(`  ${"".padEnd(11)} ${total} total\n`);

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
  description: "An operating system for agents: seven zero-dependency, MCP-native tools that form one loop.",
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
  tools: tools.map((t) => ({
    id: t.id,
    verb: t.verb,
    tagline: t.tagline,
    description: t.blurb,
    whenToUse: t.use,
    repository: `${GH}/${t.id}`,
    readme: `${RAW}/${t.id}/main/README.md`,
    npmPackage: t.package,
    version: t.version,
    // The name this server is published under in the official MCP registry
    // (registry.modelcontextprotocol.io). Mirrors each repo's server.json.
    mcpRegistryName: `io.github.tools-for-agents/${t.id}`,
    mcpServer: {
      transport: "stdio",
      // From a clone:
      command: "node",
      args: [`${t.id}/mcp/mcp-server.js`],
      // Once on npm — `npx <pkg>` runs the bin named after the package, which for the
      // six CLI tools is the CLI, so the server is reached through its `mcp` subcommand.
      npx: t.id === "agent-hq"
        ? ["npx", "-y", t.package]
        : ["npx", "-y", t.package, "mcp"],
    },
    webView: { command: `${t.id} serve`, url: `http://localhost:${t.port}` },
    mcpTools: t.mcpTools,
  })),
};
await writeFile(join(OUT, "tools.json"), JSON.stringify(manifest, null, 2) + "\n");

/* ── llms.txt ───────────────────────────────────────────────────────────── */
// Spec (llmstxt.org): H1 (the only required section), a blockquote summary,
// free-form prose, then H2 "file list" sections. "## Optional" may be skipped
// by a reader on a short context budget.
const llms = `# tools-for-agents

> An operating system for agents: seven zero-dependency, MCP-native tools that form one loop — coordinate, read code, run safely, remember, read the web, recall, and see. Every tool speaks MCP over stdio, runs locally, and ships a live web view. ${total} callable MCP tools in total.

If you are an agent, start with [tools.json](${SITE}/tools.json): one fetch gives you every tool, its install command, and the name and description of all ${total} MCP tools you can call — without cloning anything.

The kit is one loop. \`recall\` at the start of a task, \`lens\` to read code instead of opening files, \`anvil\` to run anything you have not verified, \`cortex\` to keep what you learned, \`scout\` to read the web, \`agent-hq\` to coordinate with other agents, and \`iris\` to look at what you built before claiming it works.

Requirements: Node 22+ (built-in \`node:sqlite\`), Docker for \`anvil\`, Chrome for \`iris\`. Nothing to \`npm install\` — every tool has zero runtime dependencies.

## The seven tools

${tools.map((t) => `- [${t.id}](${RAW}/${t.id}/main/README.md): ${t.verb} — ${t.blurb} ${t.mcpTools.length} MCP tools: \`${t.mcpTools.map((m) => m.name).join("`, `")}\`.`).join("\n")}

## Machine-readable

- [tools.json](${SITE}/tools.json): every tool and every callable MCP tool, as JSON. Start here.
- [llms-full.txt](${SITE}/llms-full.txt): the full README of all seven tools, concatenated into one fetch.

## Source

${tools.map((t) => `- [${t.id} on GitHub](${GH}/${t.id}): ${t.tagline}`).join("\n")}
- [the organisation](${GH}): all seven repositories, MIT, CI-green, gated by iris.

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
  `> Seven zero-dependency, MCP-native tools that form one agent loop. ${total} callable MCP tools.\n` +
  `> This file is every tool's README, concatenated, so a model can ingest the whole kit in one fetch.\n` +
  `> Curated index: ${SITE}/llms.txt · Machine-readable: ${SITE}/tools.json\n` +
  readmes.join("") + "\n");

console.log(`✓ tools.json · llms.txt · llms-full.txt  (${tools.length} tools, ${total} MCP tools)`);
