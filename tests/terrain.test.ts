import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBrushIncremental, applyBrush, decodeSample, DEFAULT_PROFILE as P, encodeSamples, toGrid, validateDimensions } from '../src/terrain.ts';
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
  for (const [w, h] of [[0, 1], [1.1, 2], [4097, 1], [NaN, 2]]) assert.throws(() => validateDimensions(w, h));
  validateDimensions(4096, 4096); validateDimensions(2048, 2048); validateDimensions(1024, 1024); validateDimensions(4096, 256);
  const invalid = map(2, 2); invalid.heights[0] = NaN;
  assert.throws(() => encodeSamples(invalid, P));
  assert.throws(() => toGrid(map(2, 2), { ...P, max: 200 }));
  assert.throws(() => toGrid(map(2, 2), { ...P, max: 126 }));
});

test('fixed target segments paint continuously without accumulating height on overlaps',()=>{
  const p={...P,mode:'clamp' as const};
  const initial={width:24,height:8,heights:new Float32Array(24*8)};
  const first=applyBrush(initial,p,{x:2,y:4,radius:1,amount:1,tool:'raise',target:2});
  const drag=applyBrush(first.map,p,{x:21,y:4,from:{x:2,y:4},radius:1,amount:1,tool:'raise',target:2});
  const overlap=applyBrush(drag.map,p,{x:2,y:4,from:{x:21,y:4},radius:1,amount:1,tool:'raise',target:2});
  for(let x=2;x<=21;x++)assert.equal(overlap.map.heights[x+4*24],2);
  assert.deepEqual(initial.heights,new Float32Array(24*8));
  const lower=applyBrush(overlap.map,p,{x:21,y:4,from:{x:2,y:4},radius:1,amount:1,tool:'lower',target:1});
  for(let x=2;x<=21;x++)assert.equal(lower.map.heights[x+4*24],1);
});

test('optimized brushes match an independent all-pairs envelope across modes and narrow maps', () => {
  for (const mode of ['linear', 'clamp', 'legacy-small', 'legacy-large'] as Mode[]) for (const slope of [1, 2] as const) {
    const p = { ...P, mode, maxSlope: slope };
    for (const [width, height] of [[1, 7], [7, 1], [6, 5]]) {
      const original = map(width, height);
      for (let i = 0; i < original.heights.length; i++) original.heights[i] = ((i * 17 + i * i) % 23) - 12 + (i % 3) * 0.25;
      const decoded = Float32Array.from(encodeSamples(original, p), v => decodeSample(v, p));
      const cone = (values: Float32Array, upper: boolean) => Float32Array.from(values, (_, i) => {
        let value = upper ? -Infinity : Infinity;
        for (let j = 0; j < values.length; j++) {
          const distance = Math.max(Math.abs(i % width - j % width), Math.abs(Math.floor(i / width) - Math.floor(j / width)));
          value = upper ? Math.max(value, values[j] - slope * distance) : Math.min(value, values[j] + slope * distance);
        }
        return value;
      });
      const base = cone(decoded, true);
      for (const tool of ['raise', 'lower', 'flatten'] as const) {
        const target = decodeSample(128, p), x = Math.floor(width / 2), y = Math.floor(height / 2), radius = 1.1;
        const selected = Array.from(base, (_, i) => Math.hypot(i % width - x, Math.floor(i / width) - y) <= radius);
        let expected: Float32Array;
        if (tool === 'flatten') {
          const lower = cone(Float32Array.from(base, (_, i) => selected[i] ? target : -Infinity), true);
          const upper = cone(Float32Array.from(base, (_, i) => selected[i] ? target : Infinity), false);
          expected = Float32Array.from(base, (v, i) => Math.max(lower[i], Math.min(upper[i], v)));
        } else {
          expected = cone(Float32Array.from(base, (v, i) => selected[i] ? Math.max(decodeSample(0, p), Math.min(decodeSample(255, p), v + (tool === 'raise' ? 3 : -3))) : v), tool === 'raise');
        }
        const actual = applyBrush(original, p, { x, y, radius, amount: 3, tool, ...(tool === 'flatten' ? { target } : {}) });
        assert.deepEqual(actual.map.heights, expected, `${mode}/${slope}/${width}x${height}/${tool}`);
        assert.equal(actual.changed, expected.reduce((count, value, i) => count + Number(value !== original.heights[i]), 0));
      }
    }
  }
});

test('incremental brush sequences equal full normalization including bounds and exported borders', () => {
  for (const mode of ['linear', 'clamp', 'legacy-small', 'legacy-large'] as Mode[]) for (const maxSlope of [1, 2] as const) {
    const p = { ...P, mode, maxSlope };
    let fast = map(151, 113, decodeSample(128, p)), full = fast;
    for (let step = 0; step < 18; step++) {
      const tool = (['raise', 'lower', 'flatten'] as const)[step % 3];
      const brush = { x: step % 4 === 0 ? 0 : (step * 31) % 151, y: step % 5 === 0 ? 112 : (step * 19) % 113, radius: 2.4, amount: 4, tool, ...(tool === 'flatten' ? { target: decodeSample(180, p) } : {}), ...(step % 4 === 3 ? { from: { x: 6, y: 7 } } : {}) };
      const expected = applyBrush(full, p, brush), actual = applyBrushIncremental(fast, p, brush);
      assert.equal(actual.incremental, true);
      assert.deepEqual(actual.map.heights, expected.map.heights, `${mode}/${maxSlope}/${step}`);
      assert.equal(actual.changed, expected.changed);
      const changed = Array.from(actual.map.heights, (v, i) => v !== fast.heights[i] ? i : -1).filter(i => i >= 0);
      assert.deepEqual([...actual.changedIndices], changed);
      for (const i of changed) {
        assert.ok(actual.bounds && i % fast.width >= actual.bounds.x0 && i % fast.width <= actual.bounds.x1 && Math.floor(i / fast.width) >= actual.bounds.y0 && Math.floor(i / fast.width) <= actual.bounds.y1);
      }
      if (!changed.length) assert.equal(actual.bounds, null);
      assert.deepEqual(toGrid(actual.map, p), toGrid(expected.map, p));
      fast = actual.map; full = expected.map;
    }
  }
});

test('incremental API falls back for raw, fractional and profile-incompatible input', () => {
  for (const kind of ['steep', 'fractional', 'unreachable']) {
    const original = map(17, 11);
    original.heights[5] = kind === 'steep' ? 20 : kind === 'fractional' ? 0.5 : 100;
    const brush = { x: 4, y: 3, radius: 2, amount: 3, tool: 'raise' as const };
    const fast = applyBrushIncremental(original, P, brush), full = applyBrush(original, P, brush);
    assert.equal(fast.incremental, false); assert.deepEqual(fast.map.heights, full.map.heights);
    assert.equal(fast.changed, full.changed);
  }
  const original = map(3, 3, 30), brush = { x: 1, y: 1, radius: 1, amount: 1, tool: 'lower' as const };
  assert.equal(applyBrushIncremental(original, P, brush).incremental, true);
  assert.equal(applyBrushIncremental(original, { ...P, max: 10 }, brush).incremental, false);
  for (const [width, height] of [[1, 9], [9, 1], [1, 1]]) {
    const m = map(width, height);
    const b = { ...brush, x: 0, y: 0 };
    assert.deepEqual(applyBrushIncremental(m, P, b).map.heights, applyBrush(m, P, b).map.heights);
  }
  assert.throws(() => applyBrushIncremental(map(4, 4), P, { ...brush, x: NaN }));
});

test('incremental no-op preserves immutable object and still validates brushes', () => {
  const original = map(101, 83);
  const brush = { x: 50, y: 41, radius: 2, amount: 1, tool: 'raise' as const, target: 0 };
  const result = applyBrushIncremental(original, P, brush);
  assert.equal(result.map, original); assert.equal(result.changed, 0);
  assert.equal(result.bounds, null); assert.equal(result.changedIndices.length, 0);
  for (const invalid of [{ ...brush, radius: 0 }, { ...brush, amount: -1 }, { ...brush, target: 0.5 }]) assert.throws(() => applyBrushIncremental(original, P, invalid));
});

test('incremental halo contains maximum-height cones at crop boundaries for legacy factors and slopes', () => {
  for (const mode of ['linear', 'clamp', 'legacy-small', 'legacy-large'] as Mode[]) for (const factor of [1, 2] as const) for (const maxSlope of [1, 2] as const) {
    const p = { ...P, mode, factor, maxSlope };
    const lo = decodeSample(0, p), hi = decodeSample(255, p);
    const reach = Math.ceil((hi - lo) / maxSlope), width = 4 * reach + 17, height = 2 * reach + 9;
    for (const direction of ['raise', 'lower'] as const) for (const tool of [direction, 'flatten'] as const) for (const location of ['middle', 'edge'] as const) {
      const initial = map(width, height, direction === 'raise' ? lo : hi);
      const target = direction === 'raise' ? hi : lo;
      const x = location === 'edge' ? 0 : Math.floor(width / 2), y = Math.floor(height / 2);
      const brush = { x, y, radius: 0.1, amount: hi - lo, tool, target };
      const expected = applyBrush(initial, p, brush), actual = applyBrushIncremental(initial, p, brush);
      assert.equal(actual.incremental, true);
      assert.deepEqual(actual.map.heights, expected.map.heights, `${mode}/factor${factor}/slope${maxSlope}/${tool}/${direction}/${location}`);
      assert.equal(actual.changed, expected.changed);
      assert.equal(actual.map.heights[y * width + x], target);
      // The outermost unchanged samples straddle the finite cone's boundary;
      // a crop that truncates propagation by even one cell fails full equality.
      for (const offset of [-reach - 1, reach + 1]) {
        const sx = x + offset;
        if (sx >= 0 && sx < width) assert.equal(actual.map.heights[y * width + sx], initial.heights[y * width + sx]);
      }
      assert.deepEqual(toGrid(actual.map, p), toGrid(expected.map, p));
    }
  }
});
