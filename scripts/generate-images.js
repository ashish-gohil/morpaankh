#!/usr/bin/env node
// Generate one PNG per (product, color) — a brand-toned editorial placeholder
// approximating the FabricSwatch JSX. 1200x1500 portrait.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const data = JSON.parse(fs.readFileSync('/Users/ashishgohil/garment-seller/scripts/products-data.json', 'utf8'));
const OUT = '/Users/ashishgohil/garment-seller/scripts/images';
fs.mkdirSync(OUT, { recursive: true });

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}
function darken(hex, amt = 0.55) {
  const c = hexToRgb(hex);
  return `rgb(${Math.round(c.r*amt)},${Math.round(c.g*amt)},${Math.round(c.b*amt)})`;
}
function lighten(hex, amt = 0.18) {
  const c = hexToRgb(hex);
  return `rgb(${Math.min(255,Math.round(c.r + (255-c.r)*amt))},${Math.min(255,Math.round(c.g + (255-c.g)*amt))},${Math.min(255,Math.round(c.b + (255-c.b)*amt))})`;
}
function isLight(hex) {
  const c = hexToRgb(hex);
  return (c.r*299 + c.g*587 + c.b*114) / 1000 > 165;
}

const W = 1200, H = 1500;

function pattern(weave, baseHex) {
  const stroke = darken(baseHex, 0.62);
  const op = 0.30;
  switch (weave) {
    case 'plain':
      return `
        <pattern id="p" patternUnits="userSpaceOnUse" width="14" height="14">
          <path d="M0 7 H14 M7 0 V14" stroke="${stroke}" stroke-opacity="${op}" stroke-width="0.9"/>
        </pattern>`;
    case 'voile':
      return `
        <pattern id="p" patternUnits="userSpaceOnUse" width="6" height="6">
          <path d="M3 0 V6" stroke="${stroke}" stroke-opacity="${op*0.8}" stroke-width="0.6"/>
        </pattern>`;
    case 'satin':
      return `
        <pattern id="p" patternUnits="userSpaceOnUse" width="20" height="20" patternTransform="rotate(45)">
          <path d="M0 10 H20" stroke="${lighten(baseHex,0.22)}" stroke-opacity="0.45" stroke-width="2.2"/>
          <path d="M0 14 H20" stroke="${stroke}" stroke-opacity="0.25" stroke-width="0.8"/>
        </pattern>`;
    case 'twill':
      return `
        <pattern id="p" patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(35)">
          <path d="M0 6 H12" stroke="${stroke}" stroke-opacity="${op}" stroke-width="1.4"/>
        </pattern>`;
    case 'dobby':
      return `
        <pattern id="p" patternUnits="userSpaceOnUse" width="18" height="18">
          <circle cx="9" cy="9" r="1.6" fill="${stroke}" fill-opacity="${op*1.1}"/>
        </pattern>`;
    case 'blockprint':
      return `
        <pattern id="p" patternUnits="userSpaceOnUse" width="44" height="44">
          <circle cx="11" cy="11" r="4" fill="${stroke}" fill-opacity="0.32"/>
          <circle cx="33" cy="33" r="4" fill="${stroke}" fill-opacity="0.32"/>
          <circle cx="33" cy="11" r="2.4" fill="${stroke}" fill-opacity="0.22"/>
          <circle cx="11" cy="33" r="2.4" fill="${stroke}" fill-opacity="0.22"/>
        </pattern>`;
    default:
      return `<pattern id="p" patternUnits="userSpaceOnUse" width="14" height="14"><path d="M0 7 H14 M7 0 V14" stroke="${stroke}" stroke-opacity="${op}" stroke-width="0.9"/></pattern>`;
  }
}

function makeSvg(product, color) {
  const baseHex = color.hex;
  const textColor = isLight(baseHex) ? '#2C2826' : '#F8F4ED';
  const subTextColor = isLight(baseHex) ? 'rgba(44,40,38,0.65)' : 'rgba(248,244,237,0.7)';
  const cornerColor = isLight(baseHex) ? 'rgba(44,40,38,0.5)' : 'rgba(248,244,237,0.6)';
  const pat = pattern(color.weave, baseHex);

  return `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>${pat}</defs>
  <rect width="${W}" height="${H}" fill="${baseHex}"/>
  <rect width="${W}" height="${H}" fill="url(#p)"/>
  <rect x="60" y="60" width="${W-120}" height="${H-120}" fill="none" stroke="${cornerColor}" stroke-width="1" stroke-opacity="0.6"/>
  <g font-family="Cormorant Garamond, Georgia, serif" fill="${textColor}">
    <text x="${W/2}" y="${H/2 - 24}" text-anchor="middle" font-size="148" font-style="italic" font-weight="500">${escapeXml(product.title.split(' ')[0])}</text>
  </g>
  <g font-family="Inter, system-ui, sans-serif" fill="${subTextColor}">
    <text x="${W/2}" y="${H/2 + 56}" text-anchor="middle" font-size="22" letter-spacing="6">${product.fabric.gsm} GSM · ${escapeXml(color.name.toUpperCase())}</text>
  </g>
  <g font-family="Inter, system-ui, sans-serif" fill="${cornerColor}" font-size="18" letter-spacing="3">
    <text x="80" y="92">TAPI &amp; CO.</text>
    <text x="${W-80}" y="92" text-anchor="end">${escapeXml(product.fabric.weave_key.toUpperCase())}</text>
    <text x="80" y="${H-72}">${escapeXml(product.handle)}</text>
    <text x="${W-80}" y="${H-72}" text-anchor="end">SURAT · 2026</text>
  </g>
</svg>`;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function run() {
  const index = [];
  for (const p of data.products) {
    for (const color of p.colors) {
      const svg = makeSvg(p, color);
      const slug = `${p.handle}-${color.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.png`;
      const outPath = path.join(OUT, slug);
      await sharp(Buffer.from(svg), { density: 144 })
        .png({ quality: 90, compressionLevel: 9 })
        .toFile(outPath);
      index.push({ handle: p.handle, color: color.name, file: outPath, basename: slug });
      process.stdout.write(`. ${slug}\n`);
    }
  }
  fs.writeFileSync(path.join(OUT, '_index.json'), JSON.stringify(index, null, 2));
  console.log(`\nGenerated ${index.length} images`);
}
run().catch(e => { console.error(e); process.exit(1); });
