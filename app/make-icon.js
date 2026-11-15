// Draws the app icon (gold bracket mark on ink, like the Tmzm theme) with no dependencies: icon.png (tray, 64 px) and
// icon.ico (the same image as a PNG-in-ICO, which Windows has supported since Vista).
'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');
const N = 256, K = N / 64; // drawn on a 64 grid, scaled up: the installer needs at least 256 px
const px = Buffer.alloc(N * N * 4);
const set = (x, y, r, g, b, a = 255) => { if (x < 0 || y < 0 || x >= N || y >= N) return; const i = (y * N + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
// rounded ink tile
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const dx = Math.max(10 * K - x, 0, x - (N - 10 * K - 1)), dy = Math.max(10 * K - y, 0, y - (N - 10 * K - 1));
  if (dx * dx + dy * dy <= 100 * K * K) set(x, y, 15, 14, 11);
}
const gold = [201, 161, 74];
const bar = (x0, y0, x1, y1) => { for (let y = y0 * K; y <= y1 * K + K - 1; y++) for (let x = x0 * K; x <= x1 * K + K - 1; x++) set(x, y, ...gold); };
// "{" and "}" as chunky strokes
bar(18, 14, 24, 18); bar(18, 14, 21, 49); bar(18, 45, 24, 49); bar(13, 29, 18, 34);
bar(40, 14, 46, 18); bar(43, 14, 46, 49); bar(40, 45, 46, 49); bar(46, 29, 51, 34);
// the dot between them
for (let y = 28 * K; y < 36 * K; y++) for (let x = 28 * K; x < 36 * K; x++) if ((x - 31.5 * K) ** 2 + (y - 31.5 * K) ** 2 <= 17 * K * K) set(x, y, ...gold);
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync('icon.png', png);
const head = Buffer.alloc(22); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = N % 256; head[7] = N % 256; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
fs.writeFileSync('icon.ico', Buffer.concat([head, png]));
console.log('icon.png and icon.ico written (' + png.length + ' bytes)');
