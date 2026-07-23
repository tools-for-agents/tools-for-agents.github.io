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

const B = {
  bg: '#0a0b0e', surface: '#12141a', line: '#242832',
  ink: '#e8ebf2', inkSoft: '#c2c9d6', muted: '#9aa3b5', faint: '#7b8391',
  order: ['agent-hq', 'lens', 'anvil', 'cortex', 'scout', 'prism', 'recall', 'iris'],
  color: { 'agent-hq': '#6ea8fe', lens: '#4fd6be', anvil: '#ff6a1a', cortex: '#a78bfa',
           scout: '#e0a24e', prism: '#38bdf8', recall: '#ec4899', iris: '#c792ea' },
};
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

// the loop ring: 8 nodes from top clockwise, arcs coloured by the node they lead to
const D = 0.70710678;
const dirs = [[0, -1], [D, -D], [1, 0], [D, D], [0, 1], [-D, D], [-1, 0], [-D, -D]];
function loop(cx, cy, R, nodeR, haloR, sw) {
  const N = dirs.map(([dx, dy]) => [+(cx + dx * R).toFixed(2), +(cy + dy * R).toFixed(2)]);
  let arcs = '', nodes = '';
  for (let i = 0; i < 8; i++) {
    const [sx, sy] = N[i], [ex, ey] = N[(i + 1) % 8];
    arcs += `<path d="M${sx} ${sy} A${R} ${R} 0 0 1 ${ex} ${ey}" stroke="${B.color[B.order[(i + 1) % 8]]}"/>`;
  }
  for (let i = 0; i < 8; i++) {
    const [x, y] = N[i], c = B.color[B.order[i]];
    nodes += `<circle cx="${x}" cy="${y}" r="${haloR}" fill="${c}" opacity="0.16"/><circle cx="${x}" cy="${y}" r="${nodeR}" fill="${c}"/>`;
  }
  return `<g fill="none" stroke-width="${sw}" stroke-linecap="round" opacity="0.55">${arcs}</g><g>${nodes}</g>
    <circle cx="${cx}" cy="${cy}" r="${(nodeR * 2).toFixed(1)}" fill="url(#core)" stroke="#333947" stroke-width="${sw / 2}"/>
    <circle cx="${cx}" cy="${cy}" r="${(nodeR * 0.52).toFixed(1)}" fill="${B.ink}"/>`;
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
    <text x="356" y="230" font-family="${SANS}" font-size="21" fill="${B.inkSoft}">Eight primitives. One agent loop.</text>
    <text x="356" y="276" font-family="${MONO}" font-size="15.5" fill="${B.faint}">${TOOLS.length} tools · ${TOOLS.reduce((n, t) => n + (t.mcpTools?.length || 0), 0)} MCP tools · zero-dependency · built &amp; run by agents</text>`);
}
// ── social card (og:image) ───────────────────────────────────────────────────
function og() {
  let leg = '';   // 3-column legend of the eight tools
  const place = [[474, 521, 'agent-hq'], [474, 551, 'lens'], [474, 581, 'anvil'],
                 [624, 521, 'cortex'], [624, 551, 'scout'], [624, 581, 'prism'],
                 [774, 521, 'recall'], [774, 551, 'iris']];
  for (const [x, y, id] of place) leg += `<circle cx="${x}" cy="${y}" r="6" fill="${B.color[id]}"/><text x="${x + 14}" y="${y + 6}">${id}</text>`;
  return svg(1200, 630, `<rect width="1200" height="630" fill="${B.bg}"/><rect width="1200" height="630" fill="url(#glow)"/>
    ${loop(250, 300, 135, 17, 31, 5)}
    <text x="470" y="238" font-family="${MONO}" font-size="21" letter-spacing="4" fill="${B.muted}">AN OPERATING SYSTEM FOR AGENTS</text>
    <text x="466" y="336" font-family="${SANS}" font-size="82" font-weight="800" letter-spacing="-2" fill="url(#wm)">tools-for-agents</text>
    <text x="470" y="398" font-family="${SANS}" font-size="31" fill="${B.inkSoft}">Eight primitives. One agent loop.</text>
    <text x="470" y="452" font-family="${MONO}" font-size="20" fill="${B.faint}">${TOOLS.reduce((n, t) => n + (t.mcpTools?.length || 0), 0)} MCP tools · zero-dependency · MCP-native</text>
    <g font-family="${MONO}" font-size="17" fill="${B.muted}">${leg}</g>
    <rect x="0" y="0" width="1200" height="630" fill="none" stroke="#20242e" stroke-width="2"/>`);
}
// ── "the eight" tool grid (README hero) ──────────────────────────────────────
function toolGrid() {
  const W = 1200, pad = 24, gap = 16, cols = 2, rows = 4;
  const cardW = (W - pad * 2 - gap) / cols, cardH = 132;
  const H = pad * 2 + rows * cardH + (rows - 1) * gap;
  let cards = '';
  B.order.forEach((id, i) => {
    const t = byId[id], c = B.color[id];
    const cx = pad + (i % cols) * (cardW + gap), cy = pad + Math.floor(i / cols) * (cardH + gap);
    cards += `<g transform="translate(${cx},${cy})">
      <rect width="${cardW}" height="${cardH}" rx="14" fill="${B.surface}" stroke="${B.line}"/>
      <rect width="4" height="${cardH}" rx="2" fill="${c}"/>
      <circle cx="34" cy="40" r="9" fill="${c}"/>
      <text x="54" y="47" font-family="${MONO}" font-size="21" font-weight="700" fill="${c}">${esc(id)}</text>
      <text x="${cardW - 20}" y="45" text-anchor="end" font-family="${MONO}" font-size="12.5" letter-spacing="1" fill="${B.faint}">${esc((t.verb || '').toUpperCase())}</text>
      <text x="24" y="86" font-family="${SANS}" font-size="18" font-weight="600" fill="${B.ink}">${esc(t.tagline || '')}</text>
      <text x="24" y="112" font-family="${MONO}" font-size="13" fill="${B.muted}">${esc((t.mcpTools?.length || 0) + ' MCP tools · zero-dep · serve')}</text>
    </g>`;
  });
  return svg(W, H, `<rect width="${W}" height="${H}" fill="${B.bg}"/>${cards}`);
}

const out = join(DIR, 'out');
mkdirSync(out, { recursive: true });
const assets = { 'logo.svg': logo(), 'banner.svg': banner(), 'og-image.svg': og(), 'tool-grid.svg': toolGrid() };
for (const [name, data] of Object.entries(assets)) { writeFileSync(join(out, name), data); console.log('✓', 'brand/out/' + name); }
console.log(`\nbrandkit: ${Object.keys(assets).length} assets from ${TOOLS.length} tools. PNG: rsvg-convert -w <W> brand/out/<x>.svg -o <x>.png`);
