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
  assert.equal(index.count/3,geometry.userData.topTriangles);
 }
 assert.equal(topTriangles,w*h*2);assert.equal(samples.size,(w+1)*(h+1));assert.ok(samples.has('9,5'));
 surface.dispose();shared.dispose();
});

test('dirty updates retain every geometry and buffer while updating border normals',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:4}),w=12,h=8;
 const initial=new Int16Array((w+1)*(h+1));surface.update(initial,w,h,0);
 const before=chunks(surface).map(mesh=>mesh.geometry),arrays=chunks(surface).map(mesh=>Object.values(mesh.geometry.attributes).map(a=>a.array)),disposed=new Set<THREE.BufferGeometry>();for(const geometry of before)geometry.addEventListener('dispose',()=>disposed.add(geometry));
 const changed=initial.slice();changed[2*(w+1)+4]=1;
 surface.update(changed,w,h,0,{x0:4,y0:2,x1:4,y1:2});
 const after=chunks(surface).map(mesh=>mesh.geometry);
 assert.deepEqual(after,before);assert.equal(disposed.size,0);
 for(let i=0;i<after.length;i++)for(const [k,a] of Object.values(after[i].attributes).entries())assert.equal(a.array,arrays[i][k]);
 assert.ok((after[0].getAttribute('position') as THREE.BufferAttribute).updateRanges.length>0);assert.equal((after[2].getAttribute('position') as THREE.BufferAttribute).updateRanges.length,0);
 // Both chunks use the same full-grid derivative at their shared x=4 edge.
 const first=after[0].getAttribute('normal'),second=after[1].getAttribute('normal');
 assert.deepEqual([first.getX(14),first.getY(14),first.getZ(14)],[second.getX(10),second.getY(10),second.getZ(10)]);
 surface.dispose();shared.dispose();
});

test('overview obeys cell budget while focus details at most four chunks and can be cleared',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:16,cellBudget:256}),w=65,h=49;
 const grid=new Int16Array((w+1)*(h+1));grid[17*(w+1)+17]=1;surface.update(grid,w,h,-2);
 const before=surface.metrics;assert.equal(before.stride,4);
 const top=()=>chunks(surface).reduce((sum,mesh)=>sum+mesh.geometry.userData.regularCellCount,0);
 assert.ok(top()<=256);
 surface.focus(16,16,4);
 assert.equal(chunks(surface).filter(mesh=>mesh.geometry.userData.stride===1).length,4);assert.ok(top()<=256+4*16*16);
 assert.ok(surface.metrics.geometryBytes>before.geometryBytes);
 for(const mesh of chunks(surface)){
  const geometry=mesh.geometry,position=geometry.getAttribute('position');
  for(let i=0;i<position.count;i++)assert.ok(position.getY(i)>=0);
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

test('a flat 128 map has no outside skirt or vertices below its actual height',()=>{
 const shared=material(),surface=new TerrainSurface(shared),w=128,h=128;
 surface.update(new Int16Array((w+1)*(h+1)).fill(1),w,h,-2);
 const mesh=chunks(surface)[0],position=mesh.geometry.getAttribute('position');
 assert.equal(mesh.geometry.boundingBox!.min.y,1);assert.equal(mesh.geometry.boundingBox!.max.y,1);
 assert.equal(position.count,(w+1)*(h+1));assert.equal(mesh.geometry.getIndex()!.count,w*h*6);
 for(let i=0;i<position.count;i++)assert.equal(position.getY(i),1);
 surface.dispose();shared.dispose();
});

test('mixed LOD boundaries share exact one-tile edges with no downward walls',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:8,cellBudget:32}),w=25,h=17;
 const grid=Int16Array.from({length:(w+1)*(h+1)},(_,i)=>((i%(w+1))+Math.floor(i/(w+1)))%5-2);
 surface.update(grid,w,h,-2);surface.focus(3,3,0);
 const boundary=(mesh:THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>,x:number)=>{
  const geometry=mesh.geometry,p=geometry.getAttribute('position'),edges=new Map<string,number>();
  const index=geometry.getIndex()!.array;
  for(let i=0;i<index.length;i+=3)for(const [a,b] of [[index[i],index[i+1]],[index[i+1],index[i+2]],[index[i+2],index[i]]]){
   if(p.getX(a)+w/2!==x||p.getX(b)+w/2!==x)continue;
   const y0=p.getZ(a)+h/2,y1=p.getZ(b)+h/2;
   const key=[Math.min(y0,y1),Math.max(y0,y1)].join(',');edges.set(key,(edges.get(key)??0)+1);
  }
  return [...edges].filter(([,count])=>count===1).map(([key])=>key).sort();
 };
 const left=chunks(surface).find(m=>m.geometry.userData.x0===0&&m.geometry.userData.y0===0)!;
 const right=chunks(surface).find(m=>m.geometry.userData.x0===8&&m.geometry.userData.y0===0)!;
 assert.equal(left.geometry.userData.stride,1);assert.ok(right.geometry.userData.stride>1);
 assert.deepEqual(boundary(left,8),boundary(right,8));assert.equal(boundary(right,8).length,8);
 let area=0;
 for(const mesh of chunks(surface)){
  const p=mesh.geometry.getAttribute('position'),index=mesh.geometry.getIndex()!.array;
  for(let i=0;i<p.count;i++)assert.ok(p.getY(i)>=-2&&p.getY(i)<=2);
  for(let i=0;i<index.length;i+=3){
   const a=index[i],b=index[i+1],c=index[i+2];
   const twice=(p.getZ(b)-p.getZ(a))*(p.getX(c)-p.getX(a))-(p.getX(b)-p.getX(a))*(p.getZ(c)-p.getZ(a));
   assert.ok(twice>0,'Every triangle faces upward and has real terrain area');area+=twice/2;
  }
 }
 assert.equal(area,w*h);surface.dispose();shared.dispose();
});

test('partial sampled heights colors normals and seam vertices equal a fresh full rebuild',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:8,cellBudget:64}),full=new TerrainSurface(shared,{chunkSize:8,cellBudget:64}),w=25,h=17;
 let grid=Int16Array.from({length:(w+1)*(h+1)},(_,i)=>(i*7)%13-6);
 surface.update(grid,w,h,-2);surface.focus(8,8,2);full.update(grid,w,h,-2);full.focus(8,8,2);
 for(const [x,y] of [[8,8],[0,0],[w,h],[16,9],[11,4],[24,8]]){
  const next=grid.slice();next[y*(w+1)+x]+=2;
  const previousGeometries=chunks(surface).map(mesh=>mesh.geometry),previousStrides=chunks(surface).map(mesh=>mesh.geometry.userData.stride);
  surface.update(next,w,h,-2,{x0:x,y0:y,x1:x,y1:y});full.update(next,w,h,-2,{x0:x,y0:y,x1:x,y1:y});full.update(next,w,h,-2);
  for(let i=0;i<surface.children.length;i++){
   const actual=chunks(surface)[i].geometry,expected=chunks(full)[i].geometry;
   if(actual.userData.stride===previousStrides[i])assert.equal(actual,previousGeometries[i]);
   for(const name of ['position','color','normal'])assert.deepEqual(actual.getAttribute(name).array,expected.getAttribute(name).array,`${name}/${x}/${y}/${i}`);
   assert.deepEqual(actual.getIndex()!.array,expected.getIndex()!.array);
  }
  grid=next;
 }
 surface.dispose();full.dispose();shared.dispose();
});


test('recently edited chunks remain detailed after cursor departure within a bounded LRU',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:8,cellBudget:64}),w=129,h=17;
 let grid=new Int16Array((w+1)*(h+1));surface.update(grid,w,h,-2);
 for(let chunk=0;chunk<15;chunk++){
  const x=chunk*8+2,y=2,next=grid.slice();next[y*(w+1)+x]=1;
  surface.focus(x,y,1);surface.update(next,w,h,-2,{x0:x,y0:y,x1:x,y1:y});grid=next;
 }
 surface.focus(128,16,1);surface.clearFocus();
 assert.equal(surface.metrics.retainedDetailCount,12);assert.ok(surface.metrics.detailedChunkCount<=16);
 assert.equal(chunks(surface).find(m=>m.geometry.userData.x0===14*8&&m.geometry.userData.y0===0)!.geometry.userData.stride,1);
 assert.equal(chunks(surface).find(m=>m.geometry.userData.x0===0&&m.geometry.userData.y0===0)!.geometry.userData.stride,surface.metrics.stride);
 surface.update(new Int16Array(25),4,4,-2);assert.equal(surface.metrics.retainedDetailCount,0);
 surface.dispose();shared.dispose();
});


test('coarse seam centers patch exactly when a broad edit exceeds retained detail capacity',()=>{
 const shared=material(),options={chunkSize:8,cellBudget:64},surface=new TerrainSurface(shared,options),full=new TerrainSurface(shared,options),w=65,h=33;
 const grid=Int16Array.from({length:(w+1)*(h+1)},(_,i)=>i%7-3),next=Int16Array.from(grid,z=>z+2),dirty={x0:0,y0:0,x1:w,y1:h};
 surface.update(grid,w,h,-2);full.update(grid,w,h,-2);
 const before=chunks(surface).map(m=>m.geometry);
 surface.update(next,w,h,-2,dirty);full.update(next,w,h,-2,dirty);full.update(next,w,h,-2);
 assert.equal(surface.metrics.retainedDetailCount,12);let patchedCoarse=0,fractional=false;
 for(let i=0;i<surface.children.length;i++){
  const actual=chunks(surface)[i].geometry,expected=chunks(full)[i].geometry;
  if(actual.userData.stride>1){assert.equal(actual,before[i]);patchedCoarse++;if(actual.userData.extra.some((v:number)=>!Number.isInteger(v)))fractional=true;}
  for(const name of ['position','color','normal'])assert.deepEqual(actual.getAttribute(name).array,expected.getAttribute(name).array,`${name}/${i}`);
 }
 assert.ok(patchedCoarse>0);assert.ok(fractional);
 surface.dispose();full.dispose();shared.dispose();
});

test('failed retained-detail promotion leaves existing geometry and LRU unchanged',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:8,cellBudget:64}),w=65,h=33,grid=new Int16Array((w+1)*(h+1));
 surface.update(grid,w,h,-2);const before=chunks(surface).map(m=>m.geometry),metrics=surface.metrics;
 const original=(surface as any).geometry;(surface as any).geometry=()=>{throw new Error('allocation rejected');};
 assert.throws(()=>surface.update(grid,w,h,-2,{x0:2,y0:2,x1:2,y1:2}),/allocation rejected/);
 assert.deepEqual(chunks(surface).map(m=>m.geometry),before);assert.deepEqual(surface.metrics,metrics);
 (surface as any).geometry=original;surface.dispose();shared.dispose();
});


function topCamera(x:number,z:number,span:number){
 const camera=new THREE.OrthographicCamera(-span/2,span/2,span/2,-span/2,.1,2000);
 camera.position.set(x,500,z);camera.up.set(0,0,-1);camera.lookAt(x,0,z);camera.updateProjectionMatrix();camera.updateMatrixWorld();return camera;
}

test('view-aware detail covers the viewport independently of cursor within the total cell budget',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:16,cellBudget:1024}),w=128,h=128;
 surface.update(new Int16Array((w+1)*(h+1)),w,h,-2);
 assert.equal(surface.metrics.stride,4);
 surface.setView(topCamera(0,0,28),900);
 const central=chunks(surface).filter(m=>m.geometry.userData.x0>=48&&m.geometry.userData.x0<80&&m.geometry.userData.y0>=48&&m.geometry.userData.y0<80);
 assert.equal(central.length,4);assert.ok(central.every(m=>m.geometry.userData.stride<=2));
 assert.ok(surface.metrics.regularCells<=1024);assert.equal(surface.metrics.viewAware,true);
 // A cursor far outside the viewport cannot allocate an extra unbudgeted region.
 surface.focus(2,2,1);assert.ok(surface.metrics.regularCells<=1024);
 const nearCenter=central.map(m=>m.geometry.userData.stride);assert.ok(nearCenter.every(s=>s<=2));
 surface.setView(topCamera(56,56,8),900);
 const destination=chunks(surface).find(m=>m.geometry.userData.x0===112&&m.geometry.userData.y0===112)!;
 assert.equal(destination.geometry.userData.stride,1);
 assert.ok(surface.metrics.regularCells<=1024);
 surface.dispose();shared.dispose();
});

test('view plans reuse geometry when camera and quality are unchanged, and quality updates are atomic',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:16,cellBudget:1024}),w=128,h=128;
 surface.update(new Int16Array((w+1)*(h+1)),w,h,-2);const camera=topCamera(0,0,96);surface.setView(camera,900);
 const initial=chunks(surface).map(m=>m.geometry),initialCells=surface.metrics.regularCells;
 surface.setView(camera,900);assert.deepEqual(chunks(surface).map(m=>m.geometry),initial);
 surface.configure({cellBudget:4096});assert.ok(surface.metrics.regularCells>initialCells);assert.ok(surface.metrics.regularCells<=4096);
 const before=chunks(surface).map(m=>m.geometry),metrics=surface.metrics;
 const original=(surface as any).geometry;(surface as any).geometry=()=>{throw new Error('allocation rejected');};
 assert.throws(()=>surface.configure({cellBudget:16384}),/allocation rejected/);
 assert.deepEqual(chunks(surface).map(m=>m.geometry),before);assert.deepEqual(surface.metrics,metrics);
 assert.throws(()=>surface.setView(topCamera(48,48,20),900),/allocation rejected/);
 assert.deepEqual(chunks(surface).map(m=>m.geometry),before);assert.deepEqual(surface.metrics,metrics);
 (surface as any).geometry=original;
 surface.configure({cellBudget:256});assert.ok(surface.metrics.regularCells<=256);
 assert.throws(()=>surface.configure({cellBudget:0}),/Invalid/);assert.throws(()=>surface.configure({cellBudget:16777217}),/Invalid/);
 assert.throws(()=>surface.setView(camera,0),/Invalid/);
 surface.dispose();shared.dispose();
});

test('view-aware mixed strides preserve exact boundary vertices and partial updates',()=>{
 const shared=material(),surface=new TerrainSurface(shared,{chunkSize:8,cellBudget:128}),fresh=new TerrainSurface(shared,{chunkSize:8,cellBudget:128}),w=40,h=32;
 const grid=Int16Array.from({length:(w+1)*(h+1)},(_,i)=>i%7-3),camera=topCamera(-10,-6,18);
 surface.update(grid,w,h,-2);surface.setView(camera,900);fresh.update(grid,w,h,-2);fresh.setView(camera,900);
 const next=grid.slice();next[8*(w+1)+16]+=2;const dirty={x0:16,y0:8,x1:16,y1:8};
 surface.update(next,w,h,-2,dirty);fresh.update(next,w,h,-2,dirty);fresh.update(next,w,h,-2);
 assert.ok(surface.metrics.regularCells<=128);
 for(let i=0;i<surface.children.length;i++)for(const name of ['position','normal','color'])assert.deepEqual(chunks(surface)[i].geometry.getAttribute(name).array,chunks(fresh)[i].geometry.getAttribute(name).array);
 surface.dispose();fresh.dispose();shared.dispose();
});
