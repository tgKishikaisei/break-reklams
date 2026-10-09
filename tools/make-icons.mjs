#!/usr/bin/env node
/**
 * Рисует иконки расширения (красный щит со знаком «запрещено») без внешних зависимостей:
 * растеризация с суперсэмплингом + собственный PNG-кодировщик. Серые версии — для выключенного состояния.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Щит в координатах [0..1]. */
function inShield(x, y) {
  const cx = 0.5;
  const top = 0.05;
  const mid = 0.5;
  const bottom = 0.965;
  const hw = 0.41;
  if (y < top || y > bottom) return false;
  const dx = Math.abs(x - cx);
  if (y <= mid) {
    const r = 0.13;
    if (y < top + r && dx > hw - r) {
      const ddx = dx - (hw - r);
      const ddy = top + r - y;
      return ddx * ddx + ddy * ddy <= r * r;
    }
    return dx <= hw;
  }
  const t = (y - mid) / (bottom - mid);
  return dx <= hw * Math.pow(1 - Math.pow(t, 1.8), 0.85);
}

/** Знак «запрещено»: кольцо + диагональ. */
function inGlyph(x, y, stroke) {
  const cx = 0.5;
  const cy = 0.46;
  const R = 0.245;
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d <= R && d >= R - stroke) return true;
  return d < R - stroke / 2 && Math.abs(dx - dy) / Math.SQRT2 <= stroke / 2;
}

function render(size, top, bottom) {
  const ss = 8;
  const stroke = size >= 128 ? 0.075 : size >= 48 ? 0.085 : size >= 32 ? 0.1 : 0.125;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxX = 0; pxX < size; pxX++) {
      let shield = 0;
      let glyph = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxX + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (inShield(x, y)) {
            shield++;
            if (inGlyph(x, y, stroke)) glyph++;
          }
        }
      }
      const i = (py * size + pxX) * 4;
      if (!shield) continue;
      const t = py / (size - 1);
      const g = glyph / shield;
      for (let c = 0; c < 3; c++) {
        const base = top[c] + (bottom[c] - top[c]) * t;
        px[i + c] = Math.round(base + (255 - base) * g);
      }
      px[i + 3] = Math.round((255 * shield) / (ss * ss));
    }
  }
  return encodePNG(size, px);
}

await mkdir(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(path.join(OUT, `icon-${size}.png`), render(size, [255, 82, 82], [198, 40, 40]));
  await writeFile(path.join(OUT, `icon-off-${size}.png`), render(size, [170, 170, 170], [105, 105, 105]));
}
console.log(`Иконки сохранены в ${OUT}`);
