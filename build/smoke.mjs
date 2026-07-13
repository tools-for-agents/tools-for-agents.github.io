#!/usr/bin/env node
/**
 * /tools.json tells an agent "here are 69 tools you can call".
 *
 * The install test proves each server ANSWERS `tools/list`. But tools/list is STATIC —
 * it is a literal in the source. A server can advertise twenty-eight tools and fail
 * every single call, and the handshake will not notice, and neither will CI, and the
 * first thing that finds out is a model in the middle of a task.
 *
 * Listing a tool is not the same as having one. So: actually CALL one, on each server,
 * from a fresh clone, and require a real answer back.
 *
 * The tool chosen for each is the one with no preconditions — nothing indexed, nothing
 * cached, no Docker, no browser — because the point is to test the SERVER, not the
 * user's setup. (anvil_check reports whether Docker is there; it does not need it.)
 *
 *   node build/smoke.mjs /path/to/workspace
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const ROOT = process.argv[2] || ".";

// tool → [name, args, a substring the answer must contain to count as a real answer]
const SMOKE = {
  "agent-hq": ["company_stats", {}, "tasks"],
  lens:       ["lens_stats",    {}, "files"],
  anvil:      ["anvil_check",   {}, "docker"],
  cortex:     ["cortex_stats",  {}, "notes"],
  scout:      ["scout_stats",   {}, "pages"],
  recall:     ["recall_status", {}, "stores"],
  iris:       ["iris_stats",    {}, "runs"],
};

function call(tool, [name, args]) {
  return new Promise((resolve) => {
    const p = spawn("node", [join(ROOT, tool, "mcp", "mcp-server.js")], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, HQ_URL: process.env.HQ_URL || "http://localhost:7700" },
    });
    let buf = "";
    const done = (v) => { try { p.kill("SIGKILL"); } catch {} resolve(v); };
    const timer = setTimeout(() => done({ ok: false, why: "timed out after 15s" }), 15000);

    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 3) continue;
        clearTimeout(timer);
        if (msg.error) return done({ ok: false, why: `error: ${msg.error.message}` });
        const r = msg.result;
        // An MCP error is reported IN the result, as isError — not as a JSON-RPC error.
        // A smoke test that only looks at msg.error passes a tool that failed politely.
        if (r?.isError) return done({ ok: false, why: `isError: ${text(r).slice(0, 90)}` });
        return done({ ok: true, body: text(r) });
      }
    });
    p.on("error", (e) => { clearTimeout(timer); done({ ok: false, why: `spawn: ${e.message}` }); });

    const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "tools-for-agents-smoke", version: "1.0.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
  });
}

const text = (r) => (r?.content || []).map((c) => c.text || "").join(" ");

let bad = 0;
for (const [tool, spec] of Object.entries(SMOKE)) {
  const [name, , must] = spec;
  const res = await call(tool, spec);
  if (!res.ok) {
    console.log(`  ✗ ${tool.padEnd(9)} ${name} — ${res.why}`);
    bad++;
    continue;
  }
  // An empty 200 is not an answer. Require the shape the tool promises.
  if (!res.body || !res.body.includes(must)) {
    console.log(`  ✗ ${tool.padEnd(9)} ${name} — answered, but without "${must}": ${JSON.stringify(res.body).slice(0, 80)}`);
    bad++;
    continue;
  }
  console.log(`  ✓ ${tool.padEnd(9)} ${name.padEnd(14)} ${res.body.replace(/\s+/g, " ").trim().slice(0, 58)}`);
}

console.log(bad
  ? `\n✗ ${bad}/${Object.keys(SMOKE).length} servers list tools they cannot run`
  : `\n✓ every server answered a real tools/call — the 69 tools are callable, not just listed`);
process.exitCode = bad ? 1 : 0;
