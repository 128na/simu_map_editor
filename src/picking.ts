import { Ray, Vector3 } from 'three';

/** Intersect the upward-facing terrain triangles without scanning the full mesh.
 * Grid coordinates map to (x-width/2, height, z-height/2), with triangles
 * [a,c,b] and [b,c,d]. The ray need not have a normalized direction.
 */
export function intersectTerrain(ray: Ray, grid: Int16Array, width: number, height: number): Vector3 | null {
  if (grid.length !== (width + 1) * (height + 1) || width < 1 || height < 1) throw new Error('Invalid terrain grid');
  const ox = ray.origin.x + width / 2, oz = ray.origin.z + height / 2;
  const dx = ray.direction.x, dz = ray.direction.z;
  let entry = 0, exit = Infinity;
  for (const [origin, direction, size] of [[ox, dx, width], [oz, dz, height]]) {
    if (direction === 0) { if (origin < 0 || origin > size) return null; }
    else {
      const a = -origin / direction, b = (size - origin) / direction;
      entry = Math.max(entry, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    }
  }
  if (entry > exit || ray.direction.lengthSq() === 0) return null;
  let x = Math.max(0, Math.min(width - 1, Math.floor(ox + entry * dx)));
  let z = Math.max(0, Math.min(height - 1, Math.floor(oz + entry * dz)));
  const sx = Math.sign(dx), sz = Math.sign(dz);
  const stepX = dx === 0 ? Infinity : Math.abs(1 / dx), stepZ = dz === 0 ? Infinity : Math.abs(1 / dz);
  let nextX = dx === 0 ? Infinity : (x + (sx > 0 ? 1 : 0) - ox) / dx;
  let nextZ = dz === 0 ? Infinity : (z + (sz > 0 ? 1 : 0) - oz) / dz;
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), d = new Vector3(), hit = new Vector3();
  let nearest: Vector3 | null = null, distance = Infinity;
  const directionLengthSq = ray.direction.lengthSq();
  const vertex = (out: Vector3, vx: number, vz: number) => out.set(vx - width / 2, grid[vz * (width + 1) + vx], vz - height / 2);
  const check = (v1: Vector3, v2: Vector3, v3: Vector3) => {
    if (ray.intersectTriangle(v1, v2, v3, true, hit)) {
      const t = ((hit.x - ray.origin.x) * ray.direction.x + (hit.y - ray.origin.y) * ray.direction.y + (hit.z - ray.origin.z) * ray.direction.z) / directionLengthSq;
      if (t < distance) { distance = t; nearest = hit.clone(); }
    }
  };
  while (x >= 0 && x < width && z >= 0 && z < height) {
    // Adjacent cells cover rays exactly on grid edges/corners, including front
    // facing triangles on either side of a crease. This remains constant work.
    for (let zz = Math.max(0, z - 1); zz <= Math.min(height - 1, z + 1); zz++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
        vertex(a, xx, zz); vertex(b, xx + 1, zz); vertex(c, xx, zz + 1); vertex(d, xx + 1, zz + 1);
        check(a, c, b); check(b, c, d);
      }
    }
    const next = Math.min(nextX, nextZ, exit);
    if (distance <= next + 1e-9 || next === Infinity || next >= exit) break;
    if (nextX <= nextZ) { x += sx; nextX += stepX; }
    else { z += sz; nextZ += stepZ; }
  }
  return nearest;
}
