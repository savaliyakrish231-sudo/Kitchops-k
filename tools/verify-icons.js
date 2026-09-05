'use strict';

/**
 * Decodes the generated icons and checks they actually show the KO mark.
 *
 * A favicon that is a blank tile, or an opaque black square, still "generates
 * fine" — only the pixels prove it. This does a real PNG decode: chunk walk,
 * inflate, and per-row de-filtering (types 0-4), because skipping the filter
 * bytes yields garbage that can look plausible.
 *
 *   npm run verify:icons
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PUBLIC = path.join(__dirname, '..', 'public');

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Minimal PNG decoder: 8-bit, non-interlaced. Returns {width,height,channels,data}. */
function decodePng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body.readUInt8(8),
        colourType: body.readUInt8(9),
        interlace: body.readUInt8(12),
      };
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8) throw new Error(`unsupported bit depth ${ihdr.depth}`);
  if (ihdr.interlace) throw new Error('interlaced PNG not supported');

  const channels = CHANNELS[ihdr.colourType];
  if (!channels) throw new Error(`unsupported colour type ${ihdr.colourType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const bpp = channels;                 // bytes per pixel at 8-bit depth
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  // Undo the per-row filter. Getting this wrong is the classic way to "verify"
  // an image and learn nothing.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;       // left
      const b = prev[i];                            // above
      const c = i >= bpp ? prev[i - bpp] : 0;       // upper-left
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error(`bad filter type ${filter} on row ${y}`);
      cur[i] = v & 0xff;
    }
  }
  return { ...ihdr, channels, data: out };
}

function analyse(file) {
  const img = decodePng(fs.readFileSync(file));
  const { width, height, channels, data } = img;
  const px = (x, y) => {
    const i = (y * width + x) * channels;
    if (channels >= 3) return { r: data[i], g: data[i + 1], b: data[i + 2], a: channels === 4 ? data[i + 3] : 255 };
    return { r: data[i], g: data[i], b: data[i], a: channels === 2 ? data[i + 1] : 255 };
  };

  let teal = 0; let light = 0; let transparent = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = px(x, y);
      if (p.a < 40) transparent++;
      else if (p.r > 190 && p.g > 190 && p.b > 190) light++;
      else if (p.g > 70 && p.g >= p.r && p.b > 50) teal++;
    }
  }
  const corner = px(0, 0);
  const centre = px(Math.floor(width / 2), Math.floor(height / 2));
  return { img, teal, light, transparent, corner, centre, total: width * height };
}

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

console.log('\nVerifying generated icons');
for (const rel of ['icons/icon-32.png', 'icons/icon-180.png', 'icons/icon-192.png']) {
  const file = path.join(PUBLIC, rel);
  if (!fs.existsSync(file)) { check(rel, false, 'missing — run npm run build:icons'); continue; }
  const a = analyse(file);
  const pctLight = (a.light / a.total) * 100;
  const pctTeal = (a.teal / a.total) * 100;

  check(`${rel} decodes`, true,
    `${a.img.width}x${a.img.height}, ${a.img.channels} channels`);
  check(`${rel} has a teal tile`, pctTeal > 25, `${pctTeal.toFixed(0)}% teal`);
  check(`${rel} shows the KO letters`, pctLight > 3,
    `${pctLight.toFixed(1)}% light pixels (the strokes)`);
  check(`${rel} has rounded (not square) corners`, a.corner.a < 40 || a.corner.a === 255 && a.img.channels < 4,
    a.img.channels === 4 ? `corner alpha ${a.corner.a}` : 'no alpha channel');
}

// The ICO must be a valid container wrapping a PNG.
const icoFile = path.join(PUBLIC, 'favicon.ico');
if (fs.existsSync(icoFile)) {
  const ico = fs.readFileSync(icoFile);
  const count = ico.readUInt16LE(4);
  const offset = ico.readUInt32LE(18);
  const payload = ico.subarray(offset, offset + ico.readUInt32LE(14));
  check('favicon.ico is a valid ICO', ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && count === 1,
    `${count} image, ${ico.readUInt8(6)}x${ico.readUInt8(7)}`);
  check('favicon.ico wraps a decodable PNG', (() => {
    try { decodePng(payload); return true; } catch { return false; }
  })());
} else {
  check('favicon.ico exists', false, 'missing — run npm run build:icons');
}

console.log(failed ? `\n\x1b[31m${failed} icon check(s) failed\x1b[0m\n` : '\n\x1b[32mIcons look right\x1b[0m\n');
process.exit(failed ? 1 : 0);
