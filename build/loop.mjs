#!/usr/bin/env node
/**
 * THE LOOP, PROVEN.
 *
 * The headline claim of this whole kit — the first line of the landing page, the first
 * line of every README — is that these are not seven tools, they are ONE LOOP:
 *
 *     coordinate → read code → run safely → remember → read the web → recall → see
 *
 * Every tool has been tested alone. Every server has been handshaken, every one of the
 * 68 tools called. The LOOP has never been run. It is the largest claim we make and the
 * least examined one, which is roughly how these things always go.
 *
 * So run it. One agent, one task, start to finish, entirely through MCP — the same wire
 * a model uses, not the library underneath it:
 *
 *   1. agent-hq  register, put a task on the board, claim it
 *   2. lens      index the code and search it instead of reading files
 *   3. anvil     run the code in a throwaway sandbox rather than trusting it
 *   4. cortex    write down what was learned, so the next task starts ahead
 *   5. scout     read a page from the web as clean markdown
 *   6. recall    ONE query, and the answer comes back from every store at once
 *   7. iris      look at the thing that was built, before saying it works
 *   8. agent-hq  move the task to Done
 *
 * Step 6 is the one that can actually fail: it is the only step that depends on all the
 * others having really happened. If cortex did not write, or scout did not cache, or
 * lens did not index, recall federates a smaller world and says so. That is the assertion
 * that makes this a loop and not a list.
 *
 *   node build/loop.mjs /path/to/clones
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.argv[2] || ".";
const WORK = mkdtempSync(join(tmpdir(), "loop-"));
const HQ = process.env.HQ_URL || "http://localhost:7700";
let failed = 0;

/** One MCP server, kept open, talked to over stdio — exactly as a model would. */
function open(tool, env = {}) {
  const p = spawn("node", [join(ROOT, tool, "mcp", "mcp-server.js")], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, HQ_URL: HQ, ...env },
  });
  let buf = "";
  const waiting = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  let id = 10;
  const rpc = (method, params) => new Promise((res, rej) => {
    const myId = ++id;
    waiting.set(myId, res);
    const t = setTimeout(() => rej(new Error(`${tool}: ${method} timed out`)), 120000);
    waiting.set(myId, (m) => { clearTimeout(t); res(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "the-loop", version: "1.0.0" } } }) + "\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  return {
    async call(name, args = {}) {
      const m = await rpc("tools/call", { name, arguments: args });
      if (m.error) throw new Error(`${name}: ${m.error.message}`);
      const text = (m.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      if (m.result?.isError) throw new Error(`${name}: ${text.slice(0, 160)}`);
      try { return JSON.parse(text); } catch { return { text }; }
    },
    close() { try { p.kill("SIGKILL"); } catch {} },
  };
}

const step = async (n, what, fn) => {
  try {
    const detail = await fn();
    console.log(`  ${n}. ${what.padEnd(22)} ✓ ${detail}`);
  } catch (e) {
    console.log(`  ${n}. ${what.padEnd(22)} ✗ ${e.message}`);
    failed++;
    throw e;
  }
};

// A page of our own to read, so the loop does not depend on someone else's uptime.
const page = createServer((_q, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><head><title>Token budgets</title></head><body><article>
    <h1>Retrieval on a token budget</h1>
    <p>An agent should pull just enough context, never a whole file. A retrieval tool fills
    to a budget and stops — and says out loud what it withheld, because a silent truncation
    reads as completeness.</p></article></body></html>`);
}).listen(0);
const pageUrl = `http://127.0.0.1:${page.address().port}/budgets`;

const servers = [];
try {
  console.log("\n  the loop — one task, start to finish, entirely over MCP\n");

  const hq = open("agent-hq"); servers.push(hq);
  const lens = open("lens", { LENS_DB: join(WORK, "lens.db") }); servers.push(lens);
  const anvil = open("anvil", { ANVIL_DB: join(WORK, "anvil.db") }); servers.push(anvil);
  const cortex = open("cortex", { CORTEX_VAULT: join(WORK, "vault") }); servers.push(cortex);
  const scout = open("scout", { SCOUT_DB: join(WORK, "scout.db") }); servers.push(scout);
  const recall = open("recall", {
    RECALL_CORTEX_DB: join(WORK, "vault", ".cortex", "index.db"),
    RECALL_SCOUT_DB: join(WORK, "scout.db"),
    RECALL_LENS_DB: join(WORK, "lens.db"),
    RECALL_HQ_URL: HQ,
  }); servers.push(recall);
  const iris = open("iris", { IRIS_OUT: join(WORK, "iris") }); servers.push(iris);

  let taskId;

  // ── 1. coordinate ────────────────────────────────────────────────────────────
  await step(1, "agent-hq  coordinate", async () => {
    await hq.call("agent_register", { name: "loop-prover", role: "integration", avatar: "🔁" });
    const task = await hq.call("kanban_create_task", {
      title: "Prove the loop actually closes",
      description: "Run all seven tools as one loop, over MCP, and make recall see the result.",
      column: "Todo", priority: "high", labels: ["verification"], created_by: "loop-prover",
    });
    taskId = task.id;
    await hq.call("kanban_claim_task", { task_id: taskId, agent: "loop-prover" });
    // And put something in the TEAM's shared memory — the fourth store recall federates,
    // and the only one that lives behind an HTTP call rather than a file on disk.
    await hq.call("memory_write", {
      title: "Retrieval on a token budget",
      content: "An agent pulls just enough context, never a whole file: the token budget fills and stops.",
      namespace: "engineering", tags: ["retrieval"], importance: 3,
    });
    return `task ${taskId} created and claimed, memory written`;
  });

  // ── 2. read code ─────────────────────────────────────────────────────────────
  await step(2, "lens      read code", async () => {
    await lens.call("lens_index", { path: join(ROOT, "recall", "src") });
    const hits = await lens.call("lens_search", { query: "token budget", k: 3 });
    if (!hits.results?.length) throw new Error("indexed the code and then found nothing in it");
    return `${hits.results.length} snippets, ~${hits.tokens} tokens (not a whole file)`;
  });

  // ── 3. run safely ────────────────────────────────────────────────────────────
  await step(3, "anvil     run safely", async () => {
    const r = await anvil.call("anvil_run_code", { lang: "python", code: "print(sum(range(1, 101)))" });
    if (r.exit_code !== 0) throw new Error(`exit ${r.exit_code}: ${r.stderr || r.stdout}`);
    if (!String(r.stdout).includes("5050")) throw new Error(`ran, but said ${JSON.stringify(r.stdout)}`);
    return `python → 5050 · exit 0 · ${r.duration_ms}ms · network off`;
  });

  // ── 4. remember ──────────────────────────────────────────────────────────────
  await step(4, "cortex    remember", async () => {
    const note = await cortex.call("cortex_write", {
      title: "Retrieval on a token budget",
      body: "An agent pulls just enough context, never a whole file. The budget fills and stops, "
        + "and what it withheld it says out loud — a silent truncation reads as completeness. See [[the-loop]].",
      tags: ["agents", "retrieval"],
    });
    if (!note.slug) throw new Error("wrote a note and got no slug back");
    return `note [[${note.slug}]] written to the vault`;
  });

  // ── 5. read the web ──────────────────────────────────────────────────────────
  await step(5, "scout     read the web", async () => {
    const p = await scout.call("scout_fetch", { url: pageUrl });
    const md = p.markdown || p.text || "";
    if (!/token budget/i.test(md)) throw new Error("fetched the page and lost its contents");
    return `${p.title || "page"} → ${md.length} chars of markdown, cached`;
  });

  // ── 6. recall it all ─────────────────────────────────────────────────────────
  // The step that can actually fail. It is the only one that depends on all the others
  // having really happened — this is what makes the seven a loop and not a list.
  await step(6, "recall    recall it all", async () => {
    const r = await recall.call("recall_search", { query: "token budget", max_tokens: 800 });
    const sources = new Set((r.results || []).map((x) => x.source));
    // Name the stores, don't count them. "3 or more" would pass on the wrong three, and
    // a check that can pass for the wrong reason is a check that has not been written.
    // Each of these EXISTS ONLY because an earlier step in this run created it:
    //   brain   ← the note cortex wrote in step 4
    //   team    ← the memory agent-hq stored in step 1
    //   reading ← the page scout cached in step 5
    //   code    ← the index lens built in step 2
    //
    // `team` was missing from this list, and the loop passed anyway — because LOCALLY my
    // agent-hq had months of memories in it, so team answered by accident. In CI, where
    // HQ starts empty, it answered nothing and nobody noticed: "3 stores at once" looked
    // like a pass. The one store that lives behind an HTTP call rather than a file was
    // the one the loop never proved. A test that quietly covers less than it claims is
    // the same bug as a tool that quietly answers less than it claims.
    const need = ["brain", "team", "reading", "code"];
    const absent = need.filter((s) => !sources.has(s));
    if (absent.length) {
      throw new Error(`${absent.join(" + ")} did not answer — the loop did not close. `
        + `What ${absent.map((s) => ({ brain: "cortex", team: "agent-hq", reading: "scout", code: "lens" }[s])).join(" and ")} `
        + `just did is not visible from here. Answered: ${[...sources].join(", ") || "nothing"}`);
    }

    // recall_search matches through the FTS tables (notes_fts, pages_fts, chunks). recall_EXPAND
    // reads the CONTENT columns directly — SELECT body FROM notes, SELECT markdown FROM pages,
    // SELECT body FROM chunks — so it couples to each sibling's schema in a way search does not.
    // If cortex renamed notes.body, search would still work and expand would silently return
    // nothing. So expand one hit from each LOCAL store, against the real stores the siblings just
    // built, and demand the full content comes back. (team expands over HTTP — a different path,
    // covered by search already.)
    for (const src of ["brain", "reading", "code"]) {
      const hit = (r.results || []).find((x) => x.source === src);
      if (!hit) continue;
      const e = await recall.call("recall_expand", { source: src, ref: hit.ref });
      if (!e || !e.text || !String(e.text).trim()) {
        throw new Error(`recall_expand("${src}", "${hit.ref}") came back empty — recall's SQL no longer `
          + `matches ${({ brain: "cortex", reading: "scout", code: "lens" }[src])}'s schema. `
          + `A column it reads (body / markdown) was renamed or dropped; search still works because it `
          + `goes through the FTS table, so this is the only place the drift shows.`);
      }
    }

    return `${r.results.length} hits from ${sources.size} stores, and expand read the full content back`;
  });

  // ── 7. see ───────────────────────────────────────────────────────────────────
  await step(7, "iris      see", async () => {
    const f = join(WORK, "built.html");
    // The viewport meta is not optional: without it a phone lays this out at 980px and scales it
    // down, and iris now (correctly) flags that at the phone viewport. The loop was quietly
    // building a page with the most common mobile bug there is and calling it "closed".
    writeFileSync(f, `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>built</title>
      <style>body{margin:0;background:#0a0b0e;color:#e8ebf2;font:16px/1.6 system-ui,sans-serif;padding:24px}
      h1{font-size:24px;margin:0 0 16px}p{color:#9aa3b5;margin:0;max-width:60ch}</style></head>
      <body><h1>The loop closed</h1><p>Seven tools, one task, one pass.</p></body></html>`);
    const r = await iris.call("iris_look", { target: f, viewports: "phone,desktop", themes: "dark" });
    const verdict = r.text || JSON.stringify(r);
    if (!/nothing broken/i.test(verdict)) throw new Error(`iris says: ${verdict.slice(0, 120)}`);
    return "rendered at phone + desktop — ✓ nothing broken";
  });

  // ── 8. close it out ──────────────────────────────────────────────────────────
  await step(8, "agent-hq  done", async () => {
    await hq.call("kanban_comment", { task_id: taskId, body: "The loop closed: recall saw what the other six did.", author: "loop-prover" });
    await hq.call("kanban_move_task", { task_id: taskId, to_column: "Done", actor: "loop-prover" });
    const t = await hq.call("kanban_get_task", { task_id: taskId });
    return `task ${taskId} → Done`;
  });

  console.log(`\n  ✓ the loop closes. Seven tools, one task, one pass — and recall could see all of it.\n`);
} catch {
  console.log(`\n  ✗ the loop does not close.\n`);
} finally {
  servers.forEach((s) => s.close());
  page.close();
  rmSync(WORK, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
