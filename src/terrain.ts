export type Mode = 'linear' | 'clamp' | 'legacy-small' | 'legacy-large';
export interface Profile { mode: Mode; min: number; max: number; factor: 1 | 2; maxSlope: 1 | 2; seaLevel: number }
export interface Heightmap { width: number; height: number; heights: Float32Array }
export const DEFAULT_PROFILE: Profile = { mode: 'linear', min: -12, max: 32, factor: 1, maxSlope: 1, seaLevel: -2 };
export const LIMITS = { maxEdge: 32766, maxTiles: 67108864, maxFileBytes: 268435456, standardEdge:4096, standardTiles:16777216 };
export function validateDimensions(w: number, h: number): void {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 || w > LIMITS.maxEdge || h > LIMITS.maxEdge || w * h > LIMITS.maxTiles) throw new Error('各辺1〜32,766の整数、合計67,108,864タイル以下で指定してください（総数はエディタの資源制約です）');
}
function profile(p: Profile): void {
  // Keep two upper sentinel/offset steps inside the native signed-byte range.
  if (!['linear', 'clamp', 'legacy-small', 'legacy-large'].includes(p.mode) || !Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min < -127 || p.max > 125 || p.min >= p.max || ![1, 2].includes(p.factor) || ![1, 2].includes(p.maxSlope) || !Number.isFinite(p.seaLevel)) throw new Error('Invalid compatibility profile');
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export function decodeSample(v: number, p: Profile): number {
  profile(p);
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error('Invalid image sample');
  switch (p.mode) {
    case 'linear': return p.min + Math.floor(v * (p.max - p.min) / 255);
    case 'clamp': return clamp(v - 128, p.min, p.max);
    case 'legacy-small': return clamp(Math.floor(6 * v / (p.factor === 2 ? 32 : 64)) - (p.factor === 2 ? 28 : 14), p.min, p.max);
    case 'legacy-large': return clamp(Math.floor(6 * v / (p.factor === 2 ? 24 : 48)) - (p.factor === 2 ? 34 : 18), p.min, p.max);
  }
}
function validMap(map: Heightmap): void {
  validateDimensions(map.width, map.height);
  if (map.heights.length !== map.width * map.height) throw new Error('Invalid height data');
  for (let i = 0; i < map.heights.length; i++) if (!Number.isFinite(map.heights[i])) throw new Error('Invalid height data');
}
export function encodeSamples(map: Heightmap, p: Profile): Uint8Array {
  validMap(map); profile(p);
  const table = Array.from({ length: 256 }, (_, i) => decodeSample(i, p));
  const inverse = new Uint8Array(p.max - p.min + 1);
  for (let target = p.min; target <= p.max; target++) {
    let best = 0;
    for (let i = 1; i < 256; i++) if (Math.abs(table[i] - target) < Math.abs(table[best] - target)) best = i;
    inverse[target - p.min] = best;
  }
  const samples = new Uint8Array(map.heights.length);
  for (let i = 0; i < samples.length; i++) samples[i] = inverse[clamp(Math.round(map.heights[i]), p.min, p.max) - p.min];
  return samples;
}
export function quantizationReport(map: Heightmap, p: Profile): { changed: number; outsideRange: number; fractional: number; reachableMin: number; reachableMax: number } {
  const samples=encodeSamples(map,p), table=Array.from({length:256},(_,v)=>decodeSample(v,p)), reachableMin=table[0], reachableMax=table[255];
  let changed=0,outsideRange=0,fractional=0;
  for(let i=0;i<samples.length;i++) {
    const value=map.heights[i];
    if(table[samples[i]]!==value) changed++;
    if(value<reachableMin || value>reachableMax) outsideRange++;
    if(!Number.isInteger(value)) fractional++;
  }
  return {changed,outsideRange,fractional,reachableMin,reachableMax};
}

// Two raster passes propagate the maximum (or minimum) Chebyshev cone.
function envelope(values: Float32Array, w: number, h: number, slope: number, upper: boolean): void {
  // Inline comparisons avoid a polymorphic Math.max/Math.min call at every edge.
  // Both passes retain the exact eight-neighbor Chebyshev envelope.
  const cost = upper ? -slope : slope;
  for (let dir = 1; dir >= -1; dir -= 2) {
    for (let y = dir === 1 ? 0 : h - 1; y >= 0 && y < h; y += dir) {
      const row = y * w, previous = row - dir * w;
      const hasPrevious = y - dir >= 0 && y - dir < h;
      for (let x = dir === 1 ? 0 : w - 1; x >= 0 && x < w; x += dir) {
        const i = row + x;
        let value = values[i], candidate: number;
        if (x - dir >= 0 && x - dir < w) {
          candidate = values[i - dir] + cost;
          if (upper ? candidate > value : candidate < value) value = candidate;
        }
        if (hasPrevious) {
          candidate = values[previous + x] + cost;
          if (upper ? candidate > value : candidate < value) value = candidate;
          if (x > 0) {
            candidate = values[previous + x - 1] + cost;
            if (upper ? candidate > value : candidate < value) value = candidate;
          }
          if (x + 1 < w) {
            candidate = values[previous + x + 1] + cost;
            if (upper ? candidate > value : candidate < value) value = candidate;
          }
        }
        values[i] = value;
      }
    }
  }
}
function baseline(map: Heightmap, p: Profile): Float32Array {
  const samples = encodeSamples(map, p);
  const table = Array.from({length:256},(_,v)=>decodeSample(v,p));
  const values = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) values[i] = table[samples[i]];
  envelope(values, map.width, map.height, p.maxSlope, true);
  return values;
}
/** Normalize editable W×H source heights; display's +1 offset is not stored. */
export function normalizeImport(map: Heightmap, p: Profile) {
  const quantization = quantizationReport(map, p);
  const samples = encodeSamples(map, p);
  const table = Array.from({length:256}, (_, v) => decodeSample(v, p));
  const heights = Float32Array.from(samples, v => table[v]);
  envelope(heights, map.width, map.height, p.maxSlope, true);
  let changed = 0, slopeChanged = 0;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] !== map.heights[i]) changed++;
    if (heights[i] !== table[samples[i]]) slopeChanged++;
  }
  return { map: {width:map.width, height:map.height, heights}, changed, slopeChanged, quantization };
}
export function toGrid(map: Heightmap, p: Profile): Int16Array {
  const samples = encodeSamples(map, p), w = map.width + 1, h = map.height + 1;
  const grid = new Float32Array(w * h), table=Array.from({length:256},(_,v)=>decodeSample(v,p));
  // Native construction duplicates source edges before normalizing slopes.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y * w + x] = table[samples[Math.min(y, map.height - 1) * map.width + Math.min(x, map.width - 1)]] + 1;
  envelope(grid, w, h, p.maxSlope, true);
  // The full render-grid conversion already proves normalization. Cache that
  // proof for immutable sources instead of scanning every neighbor again on
  // the first brush event of a newly created/imported map.
  let legal = true;
  check: for (let y=0;y<map.height;y++) for (let x=0;x<map.width;x++) {
    const i=y*map.width+x,value=map.heights[i];
    if(table[samples[i]]!==value || grid[y*w+x]!==value+1){legal=false;break check;}
  }
  if(legal)rememberLegal(map,profileKey(p));
  return Int16Array.from(grid);
}
export function applyBrush(map: Heightmap, p: Profile, brush: { x: number; y: number; radius: number; amount: number; tool: 'raise' | 'lower' | 'flatten' | 'smooth'; target?: number; from?: { x: number; y: number } }): { map: Heightmap; changed: number } {
  const base = baseline(map, p);
  if (![brush.x, brush.y, brush.radius, brush.amount].every(Number.isFinite) || brush.radius <= 0 || brush.amount < 0 || !['raise', 'lower', 'flatten', 'smooth'].includes(brush.tool)) throw new Error('Invalid brush');
  if (brush.from && ![brush.from.x,brush.from.y].every(Number.isFinite)) throw new Error('Invalid brush path');
  if (brush.target !== undefined && (!Number.isInteger(brush.target) || !Array.from({length:256},(_,i)=>decodeSample(i,p)).includes(brush.target))) throw new Error('Brush target is not representable');
  const heights = base.slice(), selected: number[] = [];
  const from=brush.from ?? brush, dx=brush.x-from.x, dy=brush.y-from.y, lengthSquared=dx*dx+dy*dy;
  for (let y=Math.max(0,Math.ceil(Math.min(from.y,brush.y)-brush.radius));y<=Math.min(map.height-1,Math.floor(Math.max(from.y,brush.y)+brush.radius));y++) {
    for (let x=Math.max(0,Math.ceil(Math.min(from.x,brush.x)-brush.radius));x<=Math.min(map.width-1,Math.floor(Math.max(from.x,brush.x)+brush.radius));x++) {
      const t=lengthSquared ? clamp(((x-from.x)*dx+(y-from.y)*dy)/lengthSquared,0,1) : 0;
      if((x-from.x-t*dx)**2+(y-from.y-t*dy)**2<=brush.radius**2) selected.push(y*map.width+x);
    }
  }
  // A segment paints every crossed sample, even when pointer events are sparse.
  if (selected.length===0 || (brush.tool!=='flatten' && brush.target===undefined && Math.round(brush.amount)===0)) return {map:{...map,heights:map.heights.slice()},changed:0};
  if (brush.tool === 'flatten') {
    const target = brush.target;
    if (target === undefined || !Number.isInteger(target) || !Array.from({ length: 256 }, (_, i) => decodeSample(i, p)).includes(target)) throw new Error('Flatten target is not representable');
    const lower = new Float32Array(base.length).fill(-Infinity), upper = new Float32Array(base.length).fill(Infinity);
    for (const i of selected) lower[i] = upper[i] = target;
    envelope(lower, map.width, map.height, p.maxSlope, true);
    envelope(upper, map.width, map.height, p.maxSlope, false);
    for (let i = 0; i < heights.length; i++) heights[i] = clamp(base[i], lower[i], upper[i]);
  } else if (brush.tool === 'smooth') {
    // Each pass reads a fixed snapshot. Even strength 1 removes one-step
    // isolated bumps; higher strengths repeat relaxation without fractional
    // height state that would conflict with the exported integer terrain.
    const passes = clamp(Math.round(brush.amount), 0, 8);
    for (let pass = 0; pass < passes; pass++) {
      const previous = pass === 0 ? base : heights.slice();
      for (const i of selected) {
        const x = i % map.width, y = Math.floor(i / map.width);
        let sum = 0, count = 0;
        for (let ny = Math.max(0, y - 1); ny <= Math.min(map.height - 1, y + 1); ny++) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(map.width - 1, x + 1); nx++) { sum += previous[ny * map.width + nx]; count++; }
        }
        heights[i] = Math.round(sum / count) || 0;
      }
      // Slopes are repaired after every pass, keeping the full and cropped
      // paths identical and limiting influence to the existing cone halo.
      envelope(heights, map.width, map.height, p.maxSlope, true);
    }
  } else {
    const lo = decodeSample(0, p), hi = decodeSample(255, p);
        for (const i of selected) heights[i] = brush.target === undefined
      ? clamp(base[i]+(brush.tool==='raise'?1:-1)*Math.round(brush.amount),lo,hi)
      : brush.tool==='raise' ? Math.max(base[i],brush.target) : Math.min(base[i],brush.target);
    envelope(heights, map.width, map.height, p.maxSlope, brush.tool === 'raise');
  }
  let changed = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] !== map.heights[i]) changed++;
  return { map: { width: map.width, height: map.height, heights }, changed };
}

export interface DirtyBounds { x0: number; y0: number; x1: number; y1: number }
export type Brush = Parameters<typeof applyBrush>[2];
export interface IncrementalBrushResult {
  map: Heightmap;
  changed: number;
  changedIndices: Uint32Array;
  bounds: DirtyBounds | null;
  incremental: boolean;
}
// Heightmap objects and their height arrays must be treated as immutable after
// this API receives them. The profile is keyed by value, so changing a profile
// never reuses a previous compatibility decision.
const legalMaps = new WeakMap<Heightmap, Set<string>>();
function profileKey(p: Profile): string { return JSON.stringify([p.mode, p.min, p.max, p.factor, p.maxSlope, p.seaLevel]); }
function rememberLegal(map: Heightmap, key: string): void {
  let keys = legalMaps.get(map);
  if (!keys) { keys = new Set(); legalMaps.set(map, keys); }
  keys.add(key);
}
function isLegal(map: Heightmap, p: Profile, key: string): boolean {
  if (legalMaps.get(map)?.has(key)) return true;
  validMap(map); profile(p);
  const reachable = new Set(Array.from({ length: 256 }, (_, v) => decodeSample(v, p)));
  const { width: w, height: h, heights: values } = map;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, value = values[i];
    if (!reachable.has(value)) return false;
    if (x && Math.abs(value - values[i - 1]) > p.maxSlope) return false;
    if (y) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx >= 0 && x + dx < w && Math.abs(value - values[i - w + dx]) > p.maxSlope) return false;
    }
  }
  rememberLegal(map, key);
  return true;
}
/** Exact local equivalent of applyBrush for immutable, normalized source maps. */
export function applyBrushIncremental(map: Heightmap, p: Profile, brush: Brush): IncrementalBrushResult {
  const key = profileKey(p);
  const incremental = isLegal(map, p, key);
  if (!incremental) {
    const result = applyBrush(map, p, brush), indices: number[] = [];
    let bounds: DirtyBounds | null = null;
    for (let i = 0; i < map.heights.length; i++) if (result.map.heights[i] !== map.heights[i]) {
      indices.push(i);
      const x = i % map.width, y = Math.floor(i / map.width);
      if (!bounds) bounds = { x0: x, y0: y, x1: x, y1: y };
      else { bounds.x0 = Math.min(bounds.x0, x); bounds.y0 = Math.min(bounds.y0, y); bounds.x1 = Math.max(bounds.x1, x); bounds.y1 = Math.max(bounds.y1, y); }
    }
    // applyBrush normalizes every nonempty edit, but a no-op intentionally
    // preserves raw input. Verify only when this result is used again.
    return { ...result, changedIndices: Uint32Array.from(indices), bounds, incremental };
  }
  // A seed can affect a sample only within (reachableMax-reachableMin)/slope:
  // farther cones lie outside every possible source height. One extra cell
  // keeps the crop boundary unchanged. Legal input needs no baseline repair,
  // so no external seed can affect either normalization or the local edit.
  const halo = Math.ceil((decodeSample(255, p) - decodeSample(0, p)) / p.maxSlope) + 1;
  const from = brush.from ?? brush;
  if (![brush.x, brush.y, from.x, from.y, brush.radius].every(Number.isFinite)) {
    applyBrush(map, p, brush); // Preserve the public validation error.
    throw new Error('Invalid brush path');
  }
  const x0 = Math.max(0, Math.min(map.width - 1, Math.floor(Math.min(brush.x, from.x) - brush.radius - halo)));
  const y0 = Math.max(0, Math.min(map.height - 1, Math.floor(Math.min(brush.y, from.y) - brush.radius - halo)));
  const x1 = Math.max(x0, Math.min(map.width - 1, Math.ceil(Math.max(brush.x, from.x) + brush.radius + halo)));
  const y1 = Math.max(y0, Math.min(map.height - 1, Math.ceil(Math.max(brush.y, from.y) + brush.radius + halo)));
  const width = x1 - x0 + 1, height = y1 - y0 + 1, local = new Float32Array(width * height);
  for (let y = 0; y < height; y++) local.set(map.heights.subarray((y + y0) * map.width + x0, (y + y0) * map.width + x0 + width), y * width);
  const result = applyBrush({ width, height, heights: local }, p, { ...brush, x: brush.x - x0, y: brush.y - y0, ...(brush.from ? { from: { x: from.x - x0, y: from.y - y0 } } : {}) });
  if (result.changed === 0) return { map, changed: 0, changedIndices: new Uint32Array(0), bounds: null, incremental };
  const heights = map.heights.slice(), indices: number[] = [];
  let bounds: DirtyBounds | null = null;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const localIndex = y * width + x, i = (y + y0) * map.width + x + x0;
    if (result.map.heights[localIndex] !== local[localIndex]) {
      heights[i] = result.map.heights[localIndex]; indices.push(i);
      const gx = x + x0, gy = y + y0;
      if (!bounds) bounds = { x0: gx, y0: gy, x1: gx, y1: gy };
      else { bounds.x0 = Math.min(bounds.x0, gx); bounds.y0 = Math.min(bounds.y0, gy); bounds.x1 = Math.max(bounds.x1, gx); bounds.y1 = Math.max(bounds.y1, gy); }
    }
  }
  const next = { width: map.width, height: map.height, heights };
  rememberLegal(next, key);
  return { map: next, changed: indices.length, changedIndices: Uint32Array.from(indices), bounds, incremental };
}
