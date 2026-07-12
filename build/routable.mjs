#!/usr/bin/env node
/**
 * Every tool we advertise must actually be REACHABLE.
 *
 * `tools/list` and the dispatcher are two hand-written lists in the same file, and
 * nothing keeps them in step. A tool named in one and missing from the other is a
 * silent 404 for every agent that reads /tools.json and tries to call it — and neither
 * the unit tests (which test the core, never the MCP adapter) nor the handshake
 * (which only reads the list) will ever say a word about it.
 *
 * 67 tools are advertised. Before this, seven had ever been invoked.
 *
 * So: call every single one. We do not care whether it succeeds — called with no
 * arguments, most of them SHOULD complain, and "query is required" is a tool working.
 * We care that it does not DIE: an advertised tool whose handler is missing crashes
 * from the inside ("tool.run is not a function"), and that is the signature of an
 * adapter promising something it cannot do.
 *
 * Run it against throwaway clones (the manifest job's `_tools`), never a real
 * workspace: calling 67 tools with no arguments will write a daily note and index
 * whatever it can find, and that is fine in a runner and rude anywhere else.
 *
 *   node build/routable.mjs /path/to/throwaway/clones
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const ROOT = process.argv[2];
if (!ROOT) { console.error("usage: routable.mjs <dir of throwaway clones>"); process.exit(2); }
const TOOLS = ["agent-hq", "lens", "anvil", "cortex", "scout", "recall", "iris"];

/**
 * Is this response a BROKEN tool, or a tool complaining correctly?
 *
 * We call all 67 with no arguments, so most of them SHOULD complain — "query is
 * required" is the tool working. What we are hunting is an advertised tool the server
 * cannot actually run.
 *
 * The first version of this hunted `unknown tool`, and it could never have fired: every
 * one of these servers builds tools/list FROM the same array the dispatcher looks up, so
 * a name in the list is always in the map. It was a check that could only ever pass —
 * the same "constant wearing a function's clothes" I had just fixed in the npm verifier,
 * written again one hour later.
 *
 * Found by PLANTING a tool with no handler. It does not 404. It crashes:
 *
 *     isError: true — "tool.run is not a function"
 *
 * THAT is the real signature of an adapter advertising something it cannot do, and it is
 * the one worth hunting. A tool that dies inside itself is broken however politely the
 * transport behaved.
 */
const CRASH = /is not a function|is not defined|cannot read propert|undefined is not|TypeError|ReferenceError|unknown tool/i;
function broken(m) {
  const msg = m.error?.message || "";
  if (msg && CRASH.test(msg)) return msg.slice(0, 60);
  const text = (m.result?.content || []).map((c) => c.text || "").join(" ");
  if (m.result?.isError && CRASH.test(text)) return text.replace(/^error:\s*/, "").slice(0, 60);
  return null;
}

/** Open one server, ask what it has, then try to call every last one of them. */
function interrogate(tool) {
  return new Promise((resolve) => {
    const p = spawn("node", [join(ROOT, tool, "mcp", "mcp-server.js")], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, HQ_URL: process.env.HQ_URL || "http://localhost:7700" },
    });
    const send = (o) => { try { p.stdin.write(JSON.stringify(o) + "\n"); } catch {} };
    const pending = new Map();          // id → tool name
    const unrouted = [];
    let names = [];
    let buf = "";
    const done = () => { try { p.kill("SIGKILL"); } catch {} resolve({ names, unrouted }); };
    const timer = setTimeout(() => { unrouted.push("(timed out)"); done(); }, 60000);

    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }

        if (m.id === 2 && m.result?.tools) {
          // A tool with no `annotations` is not neutral. The MCP spec's defaults are
          // pessimistic: with none, a tool is DECLARED destructive and open-world, and a
          // conformant client should warn the user before calling it. Silence is the
          // loudest possible answer here — and it is the wrong one for a read.
          for (const t of m.result.tools) {
            if (!t.annotations) unrouted.push(`${t.name} (no annotations = spec-default destructive)`);
          }
          names = m.result.tools.map((t) => t.name);
          names.forEach((n, i) => {
            pending.set(100 + i, n);
            send({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name: n, arguments: {} } });
          });
          if (!names.length) { clearTimeout(timer); done(); }
          continue;
        }
        if (!pending.has(m.id)) continue;
        const name = pending.get(m.id);
        pending.delete(m.id);
        const why = broken(m);
        if (why) unrouted.push(`${name} (${why})`);
        if (!pending.size) { clearTimeout(timer); done(); }
      }
    });
    p.on("error", () => { clearTimeout(timer); unrouted.push("(spawn failed)"); done(); });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "tools-for-agents-routable", version: "1.0.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

let total = 0, bad = 0;
for (const tool of TOOLS) {
  const { names, unrouted } = await interrogate(tool);
  total += names.length;
  bad += unrouted.length;
  if (unrouted.length) {
    console.log(`  ✗ ${tool.padEnd(9)} ${names.length} advertised, ${unrouted.length} BROKEN: ${unrouted.join(", ")}`);
  } else {
    console.log(`  ✓ ${tool.padEnd(9)} ${String(names.length).padStart(2)} advertised, ${String(names.length).padStart(2)} reachable`);
  }
}

console.log(bad
  ? `\n✗ ${bad} of ${total} advertised tools crash when called — /tools.json is lying about them`
  : `\n✓ all ${total} advertised tools are reachable — every name in /tools.json goes somewhere`);
process.exitCode = bad ? 1 : 0;
