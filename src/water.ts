import * as THREE from 'three';

/** CPU geometry arrays; GPU copies and replacement allocations are additional. */
export const WATER_GEOMETRY_BUDGET_BYTES = 16 * 1024 * 1024;
/** Keep the 4096-square allowance per tile, capped at 64 MiB for larger maps. */
export function waterGeometryBudget(width:number,height:number):number {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isSafeInteger(width*height))throw new Error('Invalid water budget dimensions');
  return Math.min(64,Math.max(16,Math.ceil(16*width*height/(4096*4096))))*1024*1024;
}
export function waterBudgetError(budget:number):Error {
  return new Error(`海岸線が複雑すぎるため、水面の表示予算（CPU配列${budget/1048576} MiB）を超えます。造成範囲を狭めるか、海面設定を変更してください。`);
}

/** Cover only the submerged part of the terrain's exact triangle tessellation.
 * Sea-level plateaus have no water face, avoiding coincident sand/water surfaces.
 */
export function createWaterMesh(grid: Int16Array, width: number, height: number, seaLevel: number): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      grid.length !== (width + 1) * (height + 1) || !Number.isFinite(seaLevel)) {
    throw new Error('Invalid water grid dimensions or sea level');
  }
  let min = Infinity, max = -Infinity;
  for (const value of grid) { min = Math.min(min, value); max = Math.max(max, value); }
  const geometry = new THREE.BufferGeometry();
  let positions: Float32Array;
  if (max < seaLevel) {
    // A wholly submerged rectangular map needs only two triangles.
    positions = new Float32Array([
      -width / 2, seaLevel, -height / 2, -width / 2, seaLevel, height / 2, width / 2, seaLevel, -height / 2,
      width / 2, seaLevel, -height / 2, -width / 2, seaLevel, height / 2, width / 2, seaLevel, height / 2,
    ]);
  } else if (min >= seaLevel) {
    positions = new Float32Array(0);
  } else {
    // Count first, then allocate exactly once. Dry triangles allocate nothing.
    let count = 0, offset = 0;
    const px = new Float64Array(4), pz = new Float64Array(4);
    const visit = (a: number, b: number, c: number, write: boolean) => {
      const ah = grid[a], bh = grid[b], ch = grid[c];
      if (ah >= seaLevel && bh >= seaLevel && ch >= seaLevel) return;
      const ids = [a, b, c];
      let n = 0;
      for (let i = 0; i < 3; i++) {
        const start = ids[i], end = ids[(i + 1) % 3];
        const sh = grid[start], eh = grid[end];
        const sx = start % (width + 1), sz = Math.floor(start / (width + 1));
        const ex = end % (width + 1), ez = Math.floor(end / (width + 1));
        if (sh < seaLevel) { px[n] = sx; pz[n++] = sz; }
        if ((sh < seaLevel) !== (eh < seaLevel)) {
          const t = (seaLevel - sh) / (eh - sh);
          px[n] = sx + t * (ex - sx); pz[n++] = sz + t * (ez - sz);
        }
      }
      for (let i = 1; i < n - 1; i++) {
        const area = (pz[i] - pz[0]) * (px[i + 1] - px[0]) - (px[i] - px[0]) * (pz[i + 1] - pz[0]);
        if (area <= 0) continue; // Includes repeated boundary vertices.
        if (!write) { count += 9; continue; }
        for (const j of [0, i, i + 1]) {
          positions[offset++] = px[j] - width / 2;
          positions[offset++] = seaLevel;
          positions[offset++] = pz[j] - height / 2;
        }
      }
    };
    const pass = (write: boolean) => {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const a = y * (width + 1) + x, b = a + 1, c = a + width + 1, d = c + 1;
          if (grid[a] < seaLevel && grid[b] < seaLevel && grid[c] < seaLevel && grid[d] < seaLevel) {
            // Merge consecutive fully wet cells into a strip; only the shoreline
            // needs the terrain's per-triangle tessellation.
            const startX = x;
            while (x + 1 < width) {
              const topRight = y * (width + 1) + x + 2;
              if (grid[topRight] >= seaLevel || grid[topRight + width + 1] >= seaLevel) break;
              x++;
            }
            if (!write) { count += 18; continue; }
            for (const [vx, vz] of [[startX, y], [startX, y + 1], [x + 1, y], [x + 1, y], [startX, y + 1], [x + 1, y + 1]]) {
              positions[offset++] = vx - width / 2; positions[offset++] = seaLevel; positions[offset++] = vz - height / 2;
            }
          } else {
            visit(a, c, b, write); visit(b, c, d, write);
          }
        }
      }
    };
    pass(false);
    if (count * (Float32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT) > WATER_GEOMETRY_BUDGET_BYTES) {
      throw waterBudgetError(WATER_GEOMETRY_BUDGET_BYTES);
    }
    positions = new Float32Array(count); pass(true);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Every clipped triangle lies on the same upward-facing horizontal plane.
  // Normalized bytes encode the exact unit normal without a Float32 array.
  const normals=new Uint8Array(positions.length);
  for(let i=1;i<normals.length;i+=3)normals[i]=255;
  geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3,true));
  // Empty geometry has no meaningful bounding sphere.
  if (positions.length) geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({ color: 0x4d9eaf, transparent: true, opacity: .57, roughness: .25, side: THREE.FrontSide, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material); mesh.renderOrder = 1;
  return mesh;
}
