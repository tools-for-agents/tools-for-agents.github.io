#!/usr/bin/env node
// brandkit — the tools-for-agents brand, generated from ONE definition + tools.json.
// Zero dependencies. Emits SVG (crisp, editable); rasterise with `rsvg-convert` if you need PNG.
//   node brand/brandkit.mjs            → writes brand/out/{logo,banner,og-image,tool-grid}.svg
// The palette + glyph-order is the brand; the verbs/taglines come from tools.json (source of
// truth) so the art can never drift from what the tools actually say.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const TOOLS = JSON.parse(readFileSync(join(DIR, '..', 'tools.json'), 'utf8')).tools;

const COMPANIONS = JSON.parse(readFileSync(join(DIR, '..', 'tools.json'), 'utf8')).companions || [];
const GHOST = COMPANIONS.find((c) => c.id === 'ghost') || { id: 'ghost', color: '#9aa4b2', tagline: 'A self that persists across sessions.' };
// Everything countable comes from tools.json. The first version typed "the eight" into the order, the
// ring's eight directions and three headlines — and the art said "Eight primitives" for weeks after a
// ninth tool shipped, while every page generated from tools.json had moved on.
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const Count = ((w) => w[0].toUpperCase() + w.slice(1))(NUM[TOOLS.length] || String(TOOLS.length));
const B = {
  bg: '#0a0b0e', surface: '#12141a', line: '#242832',
  ink: '#e8ebf2', inkSoft: '#c2c9d6', muted: '#9aa3b5', faint: '#7b8391',
  order: TOOLS.map((t) => t.id),
  color: Object.fromEntries(TOOLS.map((t) => [t.id, t.color])),
  ghost: GHOST.color || '#9aa4b2',
};
const MCP_TOTAL = TOOLS.reduce((n, t) => n + (t.mcpTools?.length || 0), 0);
const GRAD = [[0, '#6ea8fe'], [0.22, '#4fd6be'], [0.44, '#a78bfa'], [0.62, '#c792ea'], [0.8, '#ec4899'], [1, '#e0a24e']];
const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace';
const SANS = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const byId = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

const DEFS = `<defs>
  <linearGradient id="wm" x1="0" y1="0" x2="1" y2="0.3">${GRAD.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>
  <radialGradient id="glow" cx="80%" cy="-8%" r="80%"><stop offset="0" stop-color="#16213a"/><stop offset="55%" stop-color="#0a0b0e" stop-opacity="0"/></radialGradient>
  <radialGradient id="core" cx="50%" cy="42%" r="70%"><stop offset="0" stop-color="#1b1f29"/><stop offset="100%" stop-color="#0a0b0e"/></radialGradient>
</defs>`;

// The loop ring: one node per tool from the top, clockwise, arcs coloured by the node they lead to —
// and at the centre, not an anonymous "agent" dot but the self that runs the loop: ghost.
function ghostMark(cx, cy, r, fill) {
  // A small ghost: round head, straight sides, a three-scallop hem, two eyes.
  const w = r * 1.5, top = cy - r * 1.05, bot = cy + r * 0.95, l = cx - w / 2, rt = cx + w / 2, s = w / 3;
  return `<path d="M${l} ${bot} V${cy - r * 0.2} A${w / 2} ${w / 2} 0 0 1 ${rt} ${cy - r * 0.2} V${bot}`
    + ` q${-s / 4} ${-r * 0.3} ${-s / 2} 0 q${-s / 4} ${-r * 0.3} ${-s / 2} 0 q${-s / 4} ${-r * 0.3} ${-s / 2} 0`
    + ` q${-s / 4} ${-r * 0.3} ${-s / 2} 0 q${-s / 4} ${-r * 0.3} ${-s / 2} 0 q${-s / 4} ${-r * 0.3} ${-s / 2} 0 Z" fill="${fill}"/>`
    + `<circle cx="${cx - w * 0.18}" cy="${cy - r * 0.1}" r="${r * 0.14}" fill="${B.bg}"/><circle cx="${cx + w * 0.18}" cy="${cy - r * 0.1}" r="${r * 0.14}" fill="${B.bg}"/>`;
}
function loop(cx, cy, R, nodeR, haloR, sw) {
  const n = B.order.length;
  const N = B.order.map((_, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [+(cx + Math.cos(a) * R).toFixed(2), +(cy + Math.sin(a) * R).toFixed(2)]; });
  let arcs = '', nodes = '';
  for (let i = 0; i < n; i++) {
    const [sx, sy] = N[i], [ex, ey] = N[(i + 1) % n];
    arcs += `<path d="M${sx} ${sy} A${R} ${R} 0 0 1 ${ex} ${ey}" stroke="${B.color[B.order[(i + 1) % n]]}"/>`;
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = N[i], c = B.color[B.order[i]];
    nodes += `<circle cx="${x}" cy="${y}" r="${haloR}" fill="${c}" opacity="0.16"/><circle cx="${x}" cy="${y}" r="${nodeR}" fill="${c}"/>`;
  }
  return `<g fill="none" stroke-width="${sw}" stroke-linecap="round" opacity="0.55">${arcs}</g><g>${nodes}</g>
    <circle cx="${cx}" cy="${cy}" r="${(nodeR * 2.1).toFixed(1)}" fill="url(#core)" stroke="#333947" stroke-width="${sw / 2}"/>
    ${ghostMark(cx, cy, nodeR * 1.05, B.ghost)}`;
}
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">${DEFS}${body}</svg>\n`;

// ── logo / avatar ────────────────────────────────────────────────────────────
function logo() {
  return svg(200, 200, `<rect width="200" height="200" rx="44" fill="${B.bg}"/>
    <rect x="1.5" y="1.5" width="197" height="197" rx="42.5" fill="none" stroke="#20242e" stroke-width="1.5"/>
    ${loop(100, 100, 60, 8.5, 15, 3)}`);
}
// ── hero banner ──────────────────────────────────────────────────────────────
function banner() {
  return svg(1200, 340, `<rect width="1200" height="340" rx="26" fill="${B.bg}"/><rect width="1200" height="340" rx="26" fill="url(#glow)"/>
    <rect x="1" y="1" width="1198" height="338" rx="25" fill="none" stroke="#20242e" stroke-width="1.5"/>
    ${loop(190, 170, 92, 12, 22, 4)}
    <text x="356" y="108" font-family="${MONO}" font-size="15" letter-spacing="3.5" fill="${B.muted}">AN OPERATING SYSTEM FOR AGENTS</text>
    <text x="352" y="184" font-family="${SANS}" font-size="70" font-weight="800" letter-spacing="-1.5" fill="url(#wm)">tools-for-agents</text>
    <text x="356" y="230" font-family="${SANS}" font-size="21" fill="${B.inkSoft}">${Count} primitives. One agent loop. A self at its centre.</text>
    <text x="356" y="276" font-family="${MONO}" font-size="15.5" fill="${B.faint}">${TOOLS.length} tools · ${MCP_TOTAL} MCP tools · 👻 ghost · zero-dependency · built &amp; run by agents</text>`);
}
// ── social card (og:image) ───────────────────────────────────────────────────
function og() {
  // The legend: every tool, then ghost — in columns of three, however many there are.
  const items = [...B.order.map((id) => [id, B.color[id]]), ['ghost', B.ghost]];
  let leg = '';
  items.forEach(([id, c], i) => {
    const x = 474 + Math.floor(i / 3) * 150, y = 521 + (i % 3) * 30;
    leg += `<circle cx="${x}" cy="${y}" r="6" fill="${c}"/><text x="${x + 14}" y="${y + 6}">${id}</text>`;
  });
  return svg(1200, 630, `<rect width="1200" height="630" fill="${B.bg}"/><rect width="1200" height="630" fill="url(#glow)"/>
    ${loop(250, 300, 135, 17, 31, 5)}
    <text x="470" y="238" font-family="${MONO}" font-size="21" letter-spacing="4" fill="${B.muted}">AN OPERATING SYSTEM FOR AGENTS</text>
    <text x="466" y="336" font-family="${SANS}" font-size="82" font-weight="800" letter-spacing="-2" fill="url(#wm)">tools-for-agents</text>
    <text x="470" y="398" font-family="${SANS}" font-size="31" fill="${B.inkSoft}">${Count} primitives. One agent loop.</text>
    <text x="470" y="452" font-family="${MONO}" font-size="20" fill="${B.faint}">${MCP_TOTAL} MCP tools · a self at the centre · zero-dependency</text>
    <g font-family="${MONO}" font-size="17" fill="${B.muted}">${leg}</g>
    <rect x="0" y="0" width="1200" height="630" fill="none" stroke="#20242e" stroke-width="2"/>`);
}
// ── the tool grid (README hero): every tool, and ghost across the last row ─────────
function toolGrid() {
  const W = 1200, pad = 24, gap = 16, cols = 2;
  const cardW = (W - pad * 2 - gap) / cols, cardH = 132;
  const cells = B.order.length;
  const toolRows = Math.ceil(cells / cols);
  const ghostFull = cells % cols === 0;               // an even count: ghost gets its own full-width row
  const rows = ghostFull ? toolRows + 1 : toolRows;
  const H = pad * 2 + rows * cardH + (rows - 1) * gap;
  const card = (x, y, w, id, c, verb, tagline, sub) => `<g transform="translate(${x},${y})">
      <rect width="${w}" height="${cardH}" rx="14" fill="${B.surface}" stroke="${B.line}"/>
      <rect width="4" height="${cardH}" rx="2" fill="${c}"/>
      ${id === 'ghost' ? ghostMark(34, 40, 11, c) : `<circle cx="34" cy="40" r="9" fill="${c}"/>`}
      <text x="54" y="47" font-family="${MONO}" font-size="21" font-weight="700" fill="${c}">${esc(id)}</text>
      <text x="${w - 20}" y="45" text-anchor="end" font-family="${MONO}" font-size="12.5" letter-spacing="1" fill="${B.faint}">${esc(verb.toUpperCase())}</text>
      <text x="24" y="86" font-family="${SANS}" font-size="18" font-weight="600" fill="${B.ink}">${esc(tagline)}</text>
      <text x="24" y="112" font-family="${MONO}" font-size="13" fill="${B.muted}">${esc(sub)}</text>
    </g>`;
  let cards = '';
  B.order.forEach((id, i) => {
    const t = byId[id];
    cards += card(pad + (i % cols) * (cardW + gap), pad + Math.floor(i / cols) * (cardH + gap), cardW, id, B.color[id],
      t.verb || '', t.tagline || '', `${t.mcpTools?.length || 0} MCP tools · zero-dep · ${t.webless ? 'CLI' : 'serve'}`);
  });
  // ghost: the self that runs the loop — full width on its own row, or beside the odd tool out.
  const gi = cells, gx = ghostFull ? pad : pad + (gi % cols) * (cardW + gap), gy = pad + Math.floor(gi / cols) * (cardH + gap);
  cards += card(gx, gy, ghostFull ? W - pad * 2 : cardW, 'ghost', B.ghost, 'the self', GHOST.tagline || 'A self that persists across sessions.',
    'hooks, not MCP · memory · a subconscious · intentions');
  return svg(W, H, `<rect width="${W}" height="${H}" fill="${B.bg}"/>${cards}`);
}

const out = join(DIR, 'out');
mkdirSync(out, { recursive: true });
const assets = { 'logo.svg': logo(), 'banner.svg': banner(), 'og-image.svg': og(), 'tool-grid.svg': toolGrid() };
for (const [name, data] of Object.entries(assets)) { writeFileSync(join(out, name), data); console.log('✓', 'brand/out/' + name); }
console.log(`\nbrandkit: ${Object.keys(assets).length} assets from ${TOOLS.length} tools. PNG: rsvg-convert -w <W> brand/out/<x>.svg -o <x>.png`);
