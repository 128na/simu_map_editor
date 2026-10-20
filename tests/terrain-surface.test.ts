import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {TerrainSurface} from '../src/terrain-surface.ts';
const material=()=>new THREE.MeshStandardMaterial();
const chunks=(surface:TerrainSurface)=>surface.children as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>[];

test('chunk geometry covers rectangular odd boundaries and samples exact world grid heights',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:4}),w=9,h=5;
 const grid=Int16Array.from({length:(w+1)*(h+1)},(_,i)=>(i%(w+1))*2-Math.floor(i/(w+1)));
 surface.update(grid,w,h,-2);
 assert.equal(surface.metrics.chunkCount,6);assert.equal(surface.metrics.stride,1);
 let topTriangles=0;const samples=new Set<string>();
 for(const mesh of chunks(surface)){
  assert.equal(mesh.material,shared);
  const geometry=mesh.geometry,position=geometry.getAttribute('position');topTriangles+=geometry.userData.topTriangles;
  for(let i=0;i<geometry.userData.topVertexCount;i++){
   const x=position.getX(i)+w/2,y=position.getZ(i)+h/2;samples.add(`${x},${y}`);
   assert.equal(position.getY(i),grid[y*(w+1)+x]);
  }
  const index=geometry.getIndex()!;
  assert.equal(index.count/3,geometry.userData.topTriangles+2*(2*(geometry.userData.x1-geometry.userData.x0+geometry.userData.y1-geometry.userData.y0)));
 }
 assert.equal(topTriangles,w*h*2);assert.equal(samples.size,(w+1)*(h+1));assert.ok(samples.has('9,5'));
 surface.dispose();shared.dispose();
});

test('dirty updates retain distant chunks, update border normals and dispose only replaced buffers',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:4}),w=12,h=8;
 const initial=new Int16Array((w+1)*(h+1));surface.update(initial,w,h,0);
 const before=chunks(surface).map(mesh=>mesh.geometry),disposed=new Set<THREE.BufferGeometry>();for(const geometry of before)geometry.addEventListener('dispose',()=>disposed.add(geometry));
 const changed=initial.slice();changed[2*(w+1)+4]=1;
 surface.update(changed,w,h,0,{x0:4,y0:2,x1:4,y1:2});
 const after=chunks(surface).map(mesh=>mesh.geometry);
 assert.notEqual(after[0],before[0]);assert.notEqual(after[1],before[1]);assert.equal(after[2],before[2]);assert.equal(after[3],before[3]);assert.deepEqual(disposed,new Set(before.slice(0,2)));
 // Both chunks use the same full-grid derivative at their shared x=4 edge.
 const first=after[0].getAttribute('normal'),second=after[1].getAttribute('normal');
 assert.deepEqual([first.getX(14),first.getY(14),first.getZ(14)],[second.getX(10),second.getY(10),second.getZ(10)]);
 surface.dispose();shared.dispose();
});

test('overview obeys cell budget while focus details at most four chunks and can be cleared',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:16,cellBudget:256}),w=65,h=49;
 const grid=new Int16Array((w+1)*(h+1));grid[17*(w+1)+17]=1;surface.update(grid,w,h,-2);
 const before=surface.metrics;assert.equal(before.stride,4);
 const top=()=>chunks(surface).reduce((sum,mesh)=>sum+mesh.geometry.userData.topTriangles/2,0);
 assert.ok(top()<=256);
 surface.focus(16,16,4);
 assert.equal(chunks(surface).filter(mesh=>mesh.geometry.userData.stride===1).length,4);assert.ok(top()<=256+4*16*16);
 assert.ok(surface.metrics.geometryBytes>before.geometryBytes);
 for(const mesh of chunks(surface)){
  const geometry=mesh.geometry,position=geometry.getAttribute('position');
  for(let i=geometry.userData.topVertexCount+1;i<position.count;i+=2)assert.equal(position.getY(i),-256);
  for(const index of geometry.getIndex()!.array)assert.ok(index<position.count);
 }

 surface.focus(60,45,1);assert.ok(chunks(surface).filter(mesh=>mesh.geometry.userData.stride===1).length<=4);
 surface.clearFocus();assert.deepEqual(surface.metrics,before);
 // A sub-overview sample remains present when its region is focused.
 surface.focus(17,17,0);const detailed=chunks(surface).find(mesh=>mesh.geometry.userData.x0===16&&mesh.geometry.userData.y0===16)!;
 const position=detailed.geometry.getAttribute('position');assert.equal(position.getY(18),1);
 surface.dispose();shared.dispose();
});

test('large dimensions use a bounded overview, preserve focus normals and leave shared material alive',()=>{
 const shared=material(),surface=new TerrainSurface(shared),w=1025,h=1025;
 let materialDisposed=false;shared.addEventListener('dispose',()=>{materialDisposed=true;});
 surface.update(new Int16Array((w+1)*(h+1)),w,h,-2);
 assert.equal(surface.metrics.stride,2);assert.ok(surface.metrics.geometryBytes<24*1024*1024);assert.equal(surface.metrics.chunkCount,25);
 const previous=chunks(surface).map(mesh=>mesh.geometry);let disposed=0;for(const geometry of previous)geometry.addEventListener('dispose',()=>disposed++);
 assert.throws(()=>surface.update(new Int16Array(3),w,h,0));assert.deepEqual(chunks(surface).map(mesh=>mesh.geometry),previous);
 surface.update(new Int16Array(6),2,1,0);assert.equal(disposed,25);assert.equal(surface.metrics.chunkCount,1);
 surface.dispose();assert.equal(surface.children.length,0);assert.equal(surface.metrics.geometryBytes,0);assert.equal(materialDisposed,false);shared.dispose();
});
