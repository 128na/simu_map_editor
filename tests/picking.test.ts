import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Ray, Raycaster, Vector3 } from 'three';
import { intersectTerrain } from '../src/picking.ts';

function oracle(grid: Int16Array, width: number, height: number) {
  const positions = new Float32Array(grid.length * 3), indices: number[] = [];
  for (let z = 0; z <= height; z++) for (let x = 0; x <= width; x++) positions.set([x - width / 2, grid[z * (width + 1) + x], z - height / 2], (z * (width + 1) + x) * 3);
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) { const a = z * (width + 1) + x, b = a + 1, c = a + width + 1; indices.push(a, c, b, b, c, c + 1); }
  const geometry = new BufferGeometry(); geometry.setAttribute('position', new BufferAttribute(positions, 3)); geometry.setIndex(indices);
  return new Mesh(geometry, new MeshBasicMaterial());
}

test('grid traversal matches Three Mesh.raycast for vertical, horizontal, border and oblique rays', () => {
  for (const [width, height] of [[1, 1], [7, 3], [3, 8]]) {
    const grid = Int16Array.from({ length: (width + 1) * (height + 1) }, (_, i) => (i * 13 + Math.floor(i / (width + 1)) * 7) % 9 - 4);
    const mesh = oracle(grid, width, height);
    const rays: Ray[] = [];
    for (const x of [-width / 2 - 1, -width / 2, -width / 2 + 1, 0, width / 2]) {
      for (const z of [-height / 2, 0, height / 2, height / 2 + 1]) {
        rays.push(new Ray(new Vector3(x, 20, z), new Vector3(0, -1, 0)));
        rays.push(new Ray(new Vector3(x, -20, z), new Vector3(0, 1, 0)));
      }
    }
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
    for (let i = 0; i < 500; i++) {
      const origin = new Vector3((random() - .5) * (width + 12), (random() - .5) * 20, (random() - .5) * (height + 12));
      const direction = new Vector3(random() - .5, i % 5 === 0 ? 0 : random() - .5, random() - .5).normalize();
      rays.push(new Ray(origin, direction));
    }
    for (const ray of rays) {
      const caster = new Raycaster(ray.origin, ray.direction);
      const expected = caster.intersectObject(mesh)[0]?.point ?? null;
      const actual = intersectTerrain(ray, grid, width, height);
      assert.equal(actual === null, expected === null, `hit status ${JSON.stringify({ width, height, ray })}`);
      if (actual && expected) assert.ok(actual.distanceTo(expected) < 1e-7);
    }
    mesh.geometry.dispose(); mesh.material.dispose();
  }
});

test('non-normalized and zero-length rays are handled', () => {
  const grid = new Int16Array(4);
  assert.deepEqual(intersectTerrain(new Ray(new Vector3(0, 3, 0), new Vector3(0, -7, 0)), grid, 1, 1), new Vector3(0, 0, 0));
  assert.equal(intersectTerrain(new Ray(new Vector3(0, 3, 0), new Vector3()), grid, 1, 1), null);
});
