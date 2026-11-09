// DockWeb's own icon as a PNG, drawn without dependencies: a rounded dark square with a 3x3 grid of tiles.
// Used for the PWA touch icon (server.js) and the Mac app icon (build.sh: node icon-png.js <size> <out.png>).
import zlib from 'node:zlib';
import fs from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Coverage (0..1) of a rounded rect at pixel (x, y), with 1px anti-aliasing. */
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const d = Math.hypot(x - cx, y - cy) - r;
  const inside = x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1;
  return inside ? Math.min(1, Math.max(0, 0.5 - d)) : 0;
}

/**
 * @param {number} size  output width/height in pixels
 * @param {boolean} mac  true: macOS-style (transparent margin around a rounded square); false: full-bleed square
 */
export function makeIconPng(size, mac = false) {
  const S = size, rows = [];
  const pad = mac ? S * 0.1 : 0, box = S - 2 * pad, rad = mac ? box * 0.225 : 0;
  const inner = box * 0.18, cell = (box - 2 * inner) * 0.26, gap = ((box - 2 * inner) - 3 * cell) / 2;
  for (let y = 0; y < S; y++) {
    const row = Buffer.alloc(1 + S * 4);
    for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;
      const bg = mac ? roundRect(px, py, pad, pad, S - pad, S - pad, rad) : 1;
      let tile = 0;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        const tx = pad + inner + i * (cell + gap), ty = pad + inner + j * (cell + gap);
        tile = Math.max(tile, roundRect(px, py, tx, ty, tx + cell, ty + cell, cell * 0.22));
      }
      const mix = (a, b) => Math.round(a + (b - a) * tile);
      const o = 1 + x * 4;
      row[o] = mix(24, 96); row[o + 1] = mix(24, 165); row[o + 2] = mix(27, 250); row[o + 3] = Math.round(255 * bg);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

if (process.argv[1] && import.meta.filename === fs.realpathSync(process.argv[1])) {
  const [size, out] = process.argv.slice(2);
  fs.writeFileSync(out, makeIconPng(Number(size), true));
}
