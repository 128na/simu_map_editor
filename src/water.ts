import * as THREE from 'three';

/** Position and normal CPU arrays; GPU copies and other meshes are additional. */
export const WATER_GEOMETRY_BUDGET_BYTES = 16 * 1024 * 1024;

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
    if (count * Float32Array.BYTES_PER_ELEMENT * 2 > WATER_GEOMETRY_BUDGET_BYTES) {
      throw new Error('海岸線が複雑すぎるため、水面メッシュのメモリ上限（CPU配列16 MiB）を超えます。画像を縮小するか、海面設定を変更してください。');
    }
    positions = new Float32Array(count); pass(true);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  // Empty geometry has no meaningful bounding sphere.
  if (positions.length) geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({ color: 0x4d9eaf, transparent: true, opacity: .57, roughness: .25, side: THREE.FrontSide, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material); mesh.renderOrder = 1;
  return mesh;
}
