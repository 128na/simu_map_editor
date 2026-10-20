import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBrush, decodeSample, DEFAULT_PROFILE as P, encodeSamples, toGrid, validateDimensions } from '../src/terrain.ts';
import type { Heightmap, Mode } from '../src/terrain.ts';
const map = (w: number, h: number, v = 0): Heightmap => ({ width: w, height: h, heights: new Float32Array(w * h).fill(v) });
function constrained(m: Heightmap, slope = 1) {
  for (let y = 0; y < m.height - 1; y++) for (let x = 0; x < m.width - 1; x++) {
    const i = y * m.width + x, corners = [m.heights[i], m.heights[i + 1], m.heights[i + m.width], m.heights[i + m.width + 1]];
    assert.ok(Math.max(...corners) - Math.min(...corners) <= slope);
  }
}
test('native grayscale conversion boundaries and legacy factors', () => {
  assert.equal(decodeSample(0, P), -12); assert.equal(decodeSample(255, P), 32);
  assert.equal(decodeSample(128, { ...P, mode: 'clamp' }), 0);
  assert.equal(decodeSample(255, { ...P, mode: 'legacy-small', min: -40 }), 9);
  assert.equal(decodeSample(255, { ...P, mode: 'legacy-small', factor: 2, min: -40 }), 19);
  assert.equal(decodeSample(255, { ...P, mode: 'legacy-large', min: -40 }), 13);
  assert.equal(decodeSample(255, { ...P, mode: 'legacy-large', factor: 2, min: -40 }), 29);
});
test('grid adds one and duplicates the right and bottom edges before diagonal normalization', () => {
  const m = map(2, 2); m.heights[0] = 3;
  assert.deepEqual([...toGrid(m, P)], [4, 3, 2, 3, 3, 2, 2, 2, 2]);
});
test('a peak next to source boundary falls again at the duplicated outer vertex', () => {
  const m = map(4, 4); m.heights[2 * 4 + 2] = 5;
  const grid = toGrid(m, P);
  assert.equal(grid[2 * 5 + 2], 6);
  assert.equal(grid[2 * 5 + 3], 5);
  assert.equal(grid[2 * 5 + 4], 4);
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) {
    let expected = -Infinity;
    for (let sy = 0; sy <= 4; sy++) for (let sx = 0; sx <= 4; sx++) expected = Math.max(expected, m.heights[Math.min(sy, 3) * 4 + Math.min(sx, 3)] + 1 - Math.max(Math.abs(x - sx), Math.abs(y - sy)));
    assert.equal(grid[y * 5 + x], expected);
  }
});
test('normalization matches an independent all-pairs Chebyshev envelope', () => {
  for (const slope of [1, 2] as const) {
    const m = map(7, 5);
    for (let i = 0; i < m.heights.length; i++) m.heights[i] = ((i * 17 + i * i) % 29) - 12;
    const grid = toGrid(m, { ...P, maxSlope: slope });
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
      let expected = -Infinity;
      for (let sy = 0; sy < m.height; sy++) for (let sx = 0; sx < m.width; sx++) expected = Math.max(expected, m.heights[sy * m.width + sx] - slope * Math.max(Math.abs(x - sx), Math.abs(y - sy)));
      assert.equal(grid[y * (m.width + 1) + x], expected + 1);
    }
  }
});
test('raising propagates a cone outside brush including diagonals without mutating input', () => {
  const original = map(7, 7);
  const result = applyBrush(original, P, { x: 3, y: 3, radius: 0.1, amount: 3, tool: 'raise' });
  assert.equal(result.map.heights[24], 3); assert.equal(result.map.heights[16], 2);
  assert.equal(result.map.heights[8], 1); assert.equal(original.heights[24], 0);
  constrained(result.map); assert.equal(result.changed, 25);
});
test('lowering excavates the neighborhood and obeys double slopes at map edge', () => {
  const result = applyBrush(map(5, 5, 5), { ...P, maxSlope: 2 }, { x: 0, y: 0, radius: 0.1, amount: 6, tool: 'lower' });
  assert.equal(result.map.heights[0], -1); assert.equal(result.map.heights[6], 1); assert.equal(result.map.heights[12], 3);
  constrained(result.map, 2);
});
test('flatten creates feasible slopes on both mountain and valley sides', () => {
  const original = map(7, 7);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) original.heights[y * 7 + x] = x - 3;
  const result = applyBrush(original, P, { x: 3, y: 3, radius: 1.1, amount: 1, tool: 'flatten', target: 1 }).map;
  for (const i of [17, 23, 24, 25, 31]) assert.equal(result.heights[i], 1);
  constrained(result);
  const snapshot = original.heights.slice();
  assert.throws(() => applyBrush(original, P, { x: 3, y: 3, radius: 1, amount: 1, tool: 'flatten', target: 100 }));
  assert.deepEqual(original.heights, snapshot);
});
test('export and repeated simulated reload preserve edited grid for all conversion modes', () => {
  for (const mode of ['linear', 'clamp', 'legacy-small', 'legacy-large'] as Mode[]) for (const factor of [1, 2] as const) {
    const p = { ...P, mode, factor }, initial = map(9, 9);
    let m = applyBrush(initial, p, { x: 4, y: 4, radius: 1, amount: 5, tool: 'raise' }).map;
    const expected = toGrid(m, p);
    for (let repeat = 0; repeat < 3; repeat++) {
      m = { ...m, heights: Float32Array.from(encodeSamples(m, p), v => decodeSample(v, p)) };
      assert.deepEqual(toGrid(m, p), expected);
    }
  }
});
test('empty and zero-strength strokes preserve steep unnormalized source data', () => {
  const original = map(4, 4); original.heights[5] = 20;
  for (const brush of [
    { x: 50, y: 50, radius: 1, amount: 2, tool: 'raise' as const },
    { x: 1, y: 1, radius: 1, amount: 0, tool: 'raise' as const },
    { x: 1, y: 1, radius: 1, amount: 0.4, tool: 'lower' as const },
  ]) {
    const result = applyBrush(original, P, brush);
    assert.equal(result.changed, 0);
    assert.deepEqual(result.map.heights, original.heights);
    assert.notEqual(result.map.heights, original.heights);
  }
});
test('resource and malformed input limits reject before allocating terrain', () => {
  for (const [w, h] of [[0, 1], [1.1, 2], [4097, 1], [2048, 1024], [NaN, 2]]) assert.throws(() => validateDimensions(w, h));
  validateDimensions(1024, 1024); validateDimensions(4096, 256);
  const invalid = map(2, 2); invalid.heights[0] = NaN;
  assert.throws(() => encodeSamples(invalid, P));
  assert.throws(() => toGrid(map(2, 2), { ...P, max: 200 }));
  assert.throws(() => toGrid(map(2, 2), { ...P, max: 126 }));
});
