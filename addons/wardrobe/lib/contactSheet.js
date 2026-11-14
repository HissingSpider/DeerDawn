'use strict';

// One composed image of up to eight items, side by side, numbered 1-8.
//
// Labels are NUMBERS drawn as plain SVG rectangles (seven-segment style), not
// <text>: librsvg renders text through fontconfig, and a slim Docker image with
// no fonts installed would render blank labels or boxes. Rectangles need no
// font at all. The reply's text maps each number to the item, so the image
// carries only what a number can say.

const sharp = require('sharp');

const MAX_ITEMS = 8;
const TILE = 240;
const LABEL_H = 36;
const GAP = 12;
const PAD = 16;
const COLS = 4;
const BACKGROUND = { r: 236, g: 234, b: 230 }; // flat warm grey
const TILE_BG = { r: 255, g: 255, b: 255 };
const EMPTY_TILE = '#D9D6D0';
const INK = '#3A3A3A';

// Segments: a top, b upper right, c lower right, d bottom, e lower left,
// f upper left, g middle.
const DIGIT_SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

function digitRects(digit, x, y, w, h, t) {
  const half = h / 2;
  const seg = {
    a: [x, y, w, t],
    b: [x + w - t, y, t, half],
    c: [x + w - t, y + half, t, half],
    d: [x, y + h - t, w, t],
    e: [x, y + half, t, half],
    f: [x, y, t, half],
    g: [x, y + half - t / 2, w, t],
  };
  return (DIGIT_SEGMENTS[digit] || '')
    .split('')
    .map((s) => {
      const [rx, ry, rw, rh] = seg[s];
      return `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${INK}"/>`;
    })
    .join('');
}

function numberRects(n, cx, top) {
  const digits = String(n).split('').map(Number);
  const w = 12;
  const h = 22;
  const t = 3;
  const spacing = 5;
  const total = digits.length * w + (digits.length - 1) * spacing;
  let x = Math.round(cx - total / 2);
  let out = '';
  for (const d of digits) {
    out += digitRects(d, x, top, w, h, t);
    x += w + spacing;
  }
  return out;
}

function layout(count) {
  const cols = Math.min(count, COLS);
  const rows = Math.ceil(count / COLS);
  return {
    cols,
    rows,
    width: PAD * 2 + cols * TILE + (cols - 1) * GAP,
    height: PAD * 2 + rows * (TILE + LABEL_H) + (rows - 1) * GAP,
  };
}

function tileOrigin(index) {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return { left: PAD + col * (TILE + GAP), top: PAD + row * (TILE + LABEL_H + GAP) };
}

/**
 * tiles: [{ buffer: Buffer|null }] in display order (at most 8 used).
 * Returns { buffer, mime, width, height }.
 */
async function composeContactSheet(tiles) {
  const used = tiles.slice(0, MAX_ITEMS);
  if (!used.length) throw new Error('contact sheet needs at least one tile');
  const { width, height } = layout(used.length);

  const composites = [];
  let overlay = '';
  for (let i = 0; i < used.length; i += 1) {
    const { left, top } = tileOrigin(i);
    let tileBuffer = null;
    if (used[i].buffer) {
      try {
        tileBuffer = await sharp(used[i].buffer)
          .resize(TILE, TILE, { fit: 'contain', background: TILE_BG })
          .flatten({ background: TILE_BG })
          .png()
          .toBuffer();
      } catch {
        tileBuffer = null; // an undecodable thumb becomes an empty tile, not a failure
      }
    }
    if (tileBuffer) composites.push({ input: tileBuffer, left, top });
    else overlay += `<rect x="${left}" y="${top}" width="${TILE}" height="${TILE}" fill="${EMPTY_TILE}"/>`;
    overlay += numberRects(i + 1, left + TILE / 2, top + TILE + 7);
  }

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${overlay}</svg>`,
  );
  composites.push({ input: svg, left: 0, top: 0 });

  const buffer = await sharp({ create: { width, height, channels: 3, background: BACKGROUND } })
    .composite(composites)
    .jpeg({ quality: 82 })
    .toBuffer();
  return { buffer, mime: 'image/jpeg', width, height };
}

module.exports = { composeContactSheet, layout, MAX_ITEMS };
