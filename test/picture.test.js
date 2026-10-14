"use strict";

// The photo comparison used by EXIF › Modify (the grid part; decoding needs a browser).

const test = require("node:test");
const assert = require("node:assert/strict");
const picture = require("../src/renderer/js/picture");

const { N } = picture;

// A lopsided test picture: bright in the top-left corner, a gradient elsewhere.
function makeGrid() {
  const g = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) g[y * N + x] = x < 6 && y < 4 ? 250 : (x * 7 + y * 3) % 200;
  return g;
}

function transform(grid, opId) {
  const op = picture.OPS.find((o) => o.id === opId);
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const [sx, sy] = op.src(x, y);
    out[y * N + x] = grid[sy * N + sx];
  }
  return out;
}

test("the same picture, slightly re-saved, counts as the same", () => {
  const ref = { grid: makeGrid(), width: 4000, height: 3000 };
  const noisy = Float32Array.from(ref.grid, (v, i) => v + ((i % 5) - 2) * 2);
  assert.equal(picture.compare(ref, { grid: noisy, width: 4000, height: 3000 }).status, "same");
});

test("flips and rotations are recognised and named", () => {
  const ref = { grid: makeGrid(), width: 4000, height: 3000 };
  const cases = [
    ["flipV", 4000, 3000, "Flipped upside down"],
    ["flipH", 4000, 3000, "Mirrored left to right"],
    ["rot180", 4000, 3000, "Rotated 180°"],
    ["rot90", 3000, 4000, "Rotated 90° clockwise"],
    ["rot270", 3000, 4000, "Rotated 90° counter-clockwise"],
  ];
  for (const [op, w, hgt, label] of cases) {
    const r = picture.compare(ref, { grid: transform(ref.grid, op), width: w, height: hgt });
    assert.equal(r.status, "transformed", op);
    assert.equal(r.label, label, op);
  }
});

test("a different photo is called different", () => {
  const ref = { grid: makeGrid(), width: 4000, height: 3000 };
  const other = Float32Array.from({ length: N * N }, (_, i) => (i * 37) % 255);
  assert.equal(picture.compare(ref, { grid: other, width: 4000, height: 3000 }).status, "different");
  assert.equal(picture.compare(ref, { grid: ref.grid, width: 1000, height: 1000 }).status, "different", "a different shape is a different picture");
});
