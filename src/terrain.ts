export type Mode = 'linear' | 'clamp' | 'legacy-small' | 'legacy-large';
export interface Profile { mode: Mode; min: number; max: number; factor: 1 | 2; maxSlope: 1 | 2; seaLevel: number }
export interface Heightmap { width: number; height: number; heights: Float32Array }
export const DEFAULT_PROFILE: Profile = { mode: 'linear', min: -12, max: 32, factor: 1, maxSlope: 1, seaLevel: -2 };
export const LIMITS = { maxEdge: 4096, maxTiles: 16777216, maxFileBytes: 67108864 };
export function validateDimensions(w: number, h: number): void {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 || w > LIMITS.maxEdge || h > LIMITS.maxEdge || w * h > LIMITS.maxTiles) throw new Error('Unsupported map dimensions');
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
export function toGrid(map: Heightmap, p: Profile): Int16Array {
  const samples = encodeSamples(map, p), w = map.width + 1, h = map.height + 1;
  const grid = new Float32Array(w * h), table=Array.from({length:256},(_,v)=>decodeSample(v,p));
  // Native construction duplicates source edges before normalizing slopes.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y * w + x] = table[samples[Math.min(y, map.height - 1) * map.width + Math.min(x, map.width - 1)]] + 1;
  envelope(grid, w, h, p.maxSlope, true);
  return Int16Array.from(grid);
}
export function applyBrush(map: Heightmap, p: Profile, brush: { x: number; y: number; radius: number; amount: number; tool: 'raise' | 'lower' | 'flatten'; target?: number; from?: { x: number; y: number } }): { map: Heightmap; changed: number } {
  const base = baseline(map, p);
  if (![brush.x, brush.y, brush.radius, brush.amount].every(Number.isFinite) || brush.radius <= 0 || brush.amount < 0 || !['raise', 'lower', 'flatten'].includes(brush.tool)) throw new Error('Invalid brush');
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
