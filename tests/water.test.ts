import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWaterMesh, WATER_GEOMETRY_BUDGET_BYTES } from '../src/water.ts';

function surface(values: number[], w = 1, h = 1, sea = 0) {
  const mesh = createWaterMesh(Int16Array.from(values), w, h, sea);
  const p = mesh.geometry.getAttribute('position');
  let area = 0;
  for (let i = 0; i < p.count; i += 3) {
    const normalY = (p.getZ(i + 1) - p.getZ(i)) * (p.getX(i + 2) - p.getX(i)) -
      (p.getX(i + 1) - p.getX(i)) * (p.getZ(i + 2) - p.getZ(i));
    assert.ok(normalY > 0, 'Each water triangle faces upward and has positive area');
    area += normalY / 2;
    for (let j = i; j < i + 3; j++) assert.equal(p.getY(j), sea);
  }
  mesh.geometry.dispose(); mesh.material.dispose();
  return { mesh, p, area };
}

test('sea-level plateaus and dry terrain have no water faces', () => {
  assert.equal(surface([0, 0, 0, 0]).p.count, 0);
  assert.equal(surface([0, 2, 3, 1]).p.count, 0);
});

test('wholly submerged non-square map is a single upward rectangle at exact sea height', () => {
  const { p, area, mesh } = surface(new Array(12).fill(-2), 3, 2, 1);
  assert.equal(p.count, 6); assert.equal(area, 6);
  assert.equal(Math.min(...Array.from(p.array).filter((_, i) => i % 3 === 0)), -1.5);
  assert.equal(Math.max(...Array.from(p.array).filter((_, i) => i % 3 === 2)), 1);
  assert.equal(mesh.material.side, THREE.FrontSide);
  assert.equal(mesh.material.depthWrite, false);
});

test('sloping terrain clips at the exact sea intersection without covering dry half', () => {
  const { p, area } = surface([-1, 1, -1, 1]);
  assert.equal(area, .5);
  for (let i = 0; i < p.count; i++) assert.ok(p.getX(i) >= -.5 && p.getX(i) <= 0);
  assert.ok(Array.from(p.array).some((value, i) => i % 3 === 0 && value === 0));
});

test('asymmetric corner clips each terrain triangle using its own diagonal', () => {
  // Only a is submerged; triangle a,c,b contributes a triangle of area 1/8.
  const { p, area } = surface([-1, 1, 1, 3]);
  assert.equal(p.count, 3); assert.equal(area, .125);
});

test('sea-level vertices do not produce degenerate triangles or duplicate coverage', () => {
  assert.equal(surface([0, -1, 0, 0]).area, 1);
  assert.equal(surface([0, 0, 0, -1]).area, .5);
  assert.equal(surface([-1, 0, 0, 1]).area, .5);
});

test('merged submerged strips meet clipped coast without gaps or overlap', () => {
  const { p, area } = surface([-1, -1, 1, 1, -1, -1, 1, 1, -1, -1, 1, 1], 3, 2);
  assert.equal(area, 3);
  assert.equal(p.count / 3, 10);
  for (let i = 0; i < p.count; i++) assert.ok(p.getX(i) <= 0);
});

test('half-sea map uses a linear number of faces while preserving its exact area', () => {
  const w = 128, h = 64;
  const values = Array.from({ length: (w + 1) * (h + 1) }, (_, i) => i % (w + 1) < 64 ? -1 : 1);
  const { p, area } = surface(values, w, h);
  assert.equal(area, 63.5 * h);
  assert.equal(p.count / 3, 5 * h);
});

test('complex coastline memory guard accepts 256-square but rejects 512-square checkerboard', () => {
  const checkerboard = (size: number) => Int16Array.from({ length: (size + 1) ** 2 }, (_, i) =>
    ((i % (size + 1)) + Math.floor(i / (size + 1))) % 2 ? 1 : -1);
  const mesh = createWaterMesh(checkerboard(256), 256, 256, 0);
  const bytes = mesh.geometry.getAttribute('position').array.byteLength + mesh.geometry.getAttribute('normal').array.byteLength;
  assert.equal(bytes, 14_155_776);
  assert.ok(bytes <= WATER_GEOMETRY_BUDGET_BYTES);
  mesh.geometry.dispose(); mesh.material.dispose();
  assert.throws(() => createWaterMesh(checkerboard(512), 512, 512, 0), /CPU配列16 MiB/);
});

test('1024-square half-sea remains within water memory budget', () => {
  const size = 1024;
  const grid = Int16Array.from({ length: (size + 1) ** 2 }, (_, i) => i % (size + 1) < 512 ? -1 : 1);
  const mesh = createWaterMesh(grid, size, size, 0);
  assert.equal(mesh.geometry.getAttribute('position').count / 3, 5120);
  const bytes = mesh.geometry.getAttribute('position').array.byteLength + mesh.geometry.getAttribute('normal').array.byteLength;
  assert.ok(bytes <= WATER_GEOMETRY_BUDGET_BYTES);
  mesh.geometry.dispose(); mesh.material.dispose();
});

test('reject invalid grid size and sea values', () => {
  for (const [w, h] of [[0, 1], [1, -1], [1.5, 1], [2, 1]]) {
    assert.throws(() => createWaterMesh(new Int16Array(4), w, h, 0));
  }
  assert.throws(() => createWaterMesh(new Int16Array(4), 1, 1, NaN));
});
