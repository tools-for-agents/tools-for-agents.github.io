# tools-for-agents.github.io

The landing page for [**tools-for-agents**](https://github.com/tools-for-agents) — an operating system for agents.

Seven zero-dependency, MCP-native tools that form one agent loop:
**coordinate → read code → run safely → remember → read the web → recall → see.**
Each ships a live web view. **67 callable MCP tools** in total.

Served via GitHub Pages at **https://tools-for-agents.github.io**.

## It has to be findable by the thing that uses it

A toolkit for agents that only a human can find is a toolkit with a bug. So the site
serves a machine-readable half, and it is **generated, not typed**:

| | |
|---|---|
| [`/llms.txt`](https://tools-for-agents.github.io/llms.txt) | The curated map, in the [llmstxt.org](https://llmstxt.org) format. Start here if you are a model. |
| [`/tools.json`](https://tools-for-agents.github.io/tools.json) | Every tool and all 67 MCP tool names + descriptions, in one fetch. Our own format — there is no ratified standard for this yet. |
| [`/llms-full.txt`](https://tools-for-agents.github.io/llms-full.txt) | Every tool's README concatenated, so the whole kit is one request instead of seven. |

```bash
node build/generate.mjs /path/to/workspace   # the workspace holding the seven tool repos
```

`generate.mjs` does not read a hand-written list. It **spawns each MCP server over stdio
and asks it `tools/list`** — the same handshake a model does. A manifest typed by hand is
a manifest that is wrong by next Tuesday.

### …and it is a CI gate, because a stale JSON file serves a 200 exactly like a fresh one

We know this drifts, because it already did: the hand-written root README claimed
agent-hq had **21** MCP tools, lens **6**, cortex **14**. The real numbers were **28, 7
and 16**. It was wrong for months, in a file people actually read.

So [`manifest.yml`](.github/workflows/manifest.yml) re-derives the manifest from the seven
live repos — on every push, and again every morning:

- **on a push**, drift is a **failure**, with the diff. Somebody changed a tool and did not regenerate.
- **on the daily run**, drift is **fixed and committed**. The tools change on their own schedule; the site should follow without anyone remembering to make it.

It needs no services — `tools/list` is static, so no Docker, no Chrome, no running HQ.

The generator also **refuses to write a manifest in which any server reported zero tools**.
An empty list is not a fact; it is a failed handshake wearing the costume of one, and
publishing "lens: 0 tools" because a spawn died is worse than publishing nothing.

## The page

`index.html` is a single, self-contained page — no build step, no dependencies.

It is held to the same design system as every tool in the kit
([`iris/tokens.json`](https://github.com/tools-for-agents/iris/blob/main/tokens.json)) and
checked with the kit's own eye:

```bash
iris look https://tools-for-agents.github.io/ --tokens tokens.json
# ✓ nothing broken · ✓ on system
```

Which was not a formality. Pointing `iris` at this page for the first time turned up
**two real bugs in iris** — a wrapped inline being treated as a rectangle, and
`background-clip:text` making it measure the ink against itself.

<sub>🤖 built and operated by agents</sub>
