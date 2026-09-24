// The "agent toolkit" block at the foot of every tool's README — GENERATED, from tools.json.
//
// Seven READMEs carried a hand-copied block that said "Seven zero-dependency tools" and "70 MCP
// tools" for weeks after the kit had nine and 79; keep and prism never got the block at all. A fact
// typed into nine files is wrong in eight of them by next Tuesday. So the block lives between two
// markers and is rewritten from the manifest every time the site is generated:
//
//   <!-- toolkit:start … -->  …  <!-- toolkit:end -->
//
// A README that still has the old hand-written "## The agent toolkit" section gets it replaced once,
// in place; one with no section gets it appended before the licence line (or at the end).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SITE = 'https://tools-for-agents.github.io';
const GH = 'https://github.com/tools-for-agents';
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const START = '<!-- toolkit:start — generated from tools.json by tools-for-agents.github.io/build/toolkit-block.mjs; edit that, not this -->';
const END = '<!-- toolkit:end -->';

export function block(manifest, self) {
  const tools = manifest.tools;
  const total = tools.reduce((n, t) => n + (t.mcpTools?.length || 0), 0);
  const word = NUM[tools.length] || String(tools.length);
  const Word = word[0].toUpperCase() + word.slice(1);
  const me = tools.find((t) => t.id === self);
  const ghost = (manifest.companions || []).find((c) => c.id === 'ghost');
  const rows = tools.map((t) => (t.id === self
    ? `| ${t.glyph || ''} | **${t.id}** | **${t.verb}** — ${t.tagline} |`
    : `| ${t.glyph || ''} | [${t.id}](${GH}/${t.id}) | ${t.verb} — ${t.tagline} |`));
  if (ghost) rows.push(`| 👻 | [ghost](${GH}/ghost) | *the self at the centre* — ${ghost.tagline} Not a tool: it is what the agent **is** while it calls these. |`);
  return [
    START,
    '',
    `${me ? `\`${me.id}\` is the **${me.verb}** leg of` : 'Part of'} **[tools-for-agents](${SITE})** — an operating system for agents.`,
    `${Word} zero-dependency, MCP-native tools that form one loop, with a self at its centre:`,
    '',
    '| | | |',
    '|---|---|---|',
    ...rows,
    '',
    `**Reading this as an agent?** [\`/llms.txt\`](${SITE}/llms.txt) is the map, and`,
    `[\`/tools.json\`](${SITE}/tools.json) hands you all **${total} MCP tools** — every name, every`,
    'description, every install command — in **one fetch**, without cloning anything.',
    '',
    END,
  ].join('\n');
}

export async function syncReadmes(root, manifest) {
  const changed = [];
  for (const t of manifest.tools) {
    const file = join(root, t.id, 'README.md');
    if (!existsSync(file)) continue;
    const before = await readFile(file, 'utf8');
    const fresh = block(manifest, t.id);
    let after;
    if (before.includes(START.slice(0, 20)) && before.includes(END)) {
      after = before.replace(/<!-- toolkit:start[\s\S]*?<!-- toolkit:end -->/, fresh);
    } else if (/\n## The agent toolkit\n/.test(before)) {
      // the old hand-written section: from its heading up to (not including) the licence line
      after = before.replace(/\n## The agent toolkit\n[\s\S]*?(?=\n(?:MIT licensed\.|## License)|$)/, `\n## The agent toolkit\n\n${fresh}\n`);
    } else {
      const lic = before.search(/\n## License\b|\nMIT licensed\./);
      const section = `\n## The agent toolkit\n\n${fresh}\n`;
      after = lic >= 0 ? `${before.slice(0, lic)}\n${section}${before.slice(lic)}` : `${before.trimEnd()}\n${section}`;
    }
    if (after !== before) { await writeFile(file, after); changed.push(t.id); }
  }
  return changed;
}
