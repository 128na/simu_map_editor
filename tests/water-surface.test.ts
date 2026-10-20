import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {WaterSurface} from '../src/water-surface.ts';
import {createWaterMesh,WATER_GEOMETRY_BUDGET_BYTES} from '../src/water.ts';

type Mesh=THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;
function area(mesh:Mesh){
 const p=mesh.geometry.getAttribute('position');let total=0;
 for(let i=0;i<p.count;i+=3){
  const twice=(p.getZ(i+1)-p.getZ(i))*(p.getX(i+2)-p.getX(i))-(p.getX(i+1)-p.getX(i))*(p.getZ(i+2)-p.getZ(i));
  assert.ok(twice>0);total+=twice/2;
 }
 return total;
}
function totalArea(surface:WaterSurface){return surface.children.reduce((sum,c)=>sum+area(c as Mesh),0);}
function fullArea(grid:Int16Array,w:number,h:number,sea:number){const mesh=createWaterMesh(grid,w,h,sea);const a=area(mesh);mesh.geometry.dispose();mesh.material.dispose();return a;}

test('chunked water matches exact global area and coverage at seams on odd rectangular maps',()=>{
 const w=517,h=271,sea=0,grid=Int16Array.from({length:(w+1)*(h+1)},(_,i)=>{const x=i%(w+1),y=Math.floor(i/(w+1));return x%11<3||y%13<4?-2:2;});
 const surface=new WaterSurface(grid,w,h,sea),full=createWaterMesh(grid,w,h,sea);
 assert.ok(Math.abs(totalArea(surface)-area(full))<1e-6);
 assert.equal(surface.children.length,6);
 surface.updateMatrixWorld(true);full.updateMatrixWorld(true);
 for(const x of [255.25,255.75,256.25,256.75,511.25,512.25])for(const y of [12.25,255.25,256.25,269.25]){
  const ray=new THREE.Raycaster(new THREE.Vector3(x-w/2,100,y-h/2),new THREE.Vector3(0,-1,0));
  const expected=ray.intersectObject(full),actual=ray.intersectObjects(surface.children);
  assert.equal(actual.length>0,expected.length>0,`coverage ${x},${y}`);
  if(actual.length)assert.equal(actual[0].point.y,sea);
 }
 for(const child of surface.children){
  const mesh=child as Mesh,c=mesh.geometry.userData,p=mesh.geometry.getAttribute('position');
  assert.deepEqual(mesh.position.toArray(),[0,0,0]);
  for(let i=0;i<p.count;i++){assert.ok(p.getX(i)>=c.x0-w/2&&p.getX(i)<=c.x1-w/2);assert.ok(p.getZ(i)>=c.y0-h/2&&p.getZ(i)<=c.y1-h/2);assert.equal(p.getY(i),sea);}
 }
 full.geometry.dispose();full.material.dispose();surface.dispose();
});

test('dirty boundary update prepares atomically and replaces only adjacent water chunks',()=>{
 const w=600,h=270,grid=new Int16Array((w+1)*(h+1)).fill(-2),surface=new WaterSurface(grid,w,h,0);
 const old=surface.children.slice() as Mesh[],geometries=old.map(m=>m.geometry),disposed=new Set<THREE.BufferGeometry>();
 for(const m of old)m.geometry.addEventListener('dispose',()=>disposed.add(m.geometry));
 grid[100*(w+1)+256]=2;
 const transaction=surface.prepareUpdate(grid,w,h,0,{x0:256,y0:100,x1:256,y1:100});
 assert.deepEqual(surface.children,old);assert.equal(disposed.size,0);
 transaction.commit();transaction.commit();transaction.dispose();
 assert.equal(disposed.size,2);
 for(const i of [2,3,4,5])assert.ok(surface.children.some(c=>(c as Mesh).geometry===geometries[i]));
 assert.ok(Math.abs(totalArea(surface)-fullArea(grid,w,h,0))<1e-6);
 assert.ok(surface.metrics.geometryBytes<=WATER_GEOMETRY_BUDGET_BYTES);
 surface.dispose();
});

test('discarded or over-budget water update preserves live geometry and aggregate budget',()=>{
 const w=512,h=512,wet=new Int16Array((w+1)*(h+1)).fill(-2),surface=new WaterSurface(wet,w,h,0),old=surface.children.slice() as Mesh[];
 let oldDisposals=0;for(const m of old)m.geometry.addEventListener('dispose',()=>oldDisposals++);
 const changed=wet.slice();changed[100*(w+1)+100]=2;
 const pending=surface.prepareUpdate(changed,w,h,0,{x0:100,y0:100,x1:100,y1:100});pending.dispose();pending.dispose();pending.commit();
 assert.deepEqual(surface.children,old);assert.equal(oldDisposals,0);
 const complex=Int16Array.from({length:(w+1)*(h+1)},(_,i)=>(i%(w+1)+Math.floor(i/(w+1)))%2?-2:0);
 assert.throws(()=>surface.prepareUpdate(complex,w,h,0),/16 MiB/);
 assert.deepEqual(surface.children,old);assert.equal(oldDisposals,0);
 assert.equal(totalArea(surface),w*h);
 surface.dispose();surface.dispose();assert.equal(oldDisposals,4);
});

test('empty water chunks produce no scene children or materials and partial update creates only wet chunks',()=>{
 const w=520,h=257,grid=new Int16Array((w+1)*(h+1)).fill(1),surface=new WaterSurface(grid,w,h,0);
 assert.equal(surface.children.length,0);assert.deepEqual(surface.materials,[]);assert.deepEqual(surface.metrics,{geometryBytes:0,triangles:0});
 grid[100*(w+1)+100]=-2;const pending=surface.prepareUpdate(grid,w,h,0,{x0:100,y0:100,x1:100,y1:100});
 assert.equal(surface.children.length,0);pending.commit();assert.equal(surface.children.length,1);assert.equal(surface.materials.length,1);
 assert.ok(Math.abs(totalArea(surface)-fullArea(grid,w,h,0))<1e-6);
 surface.dispose();assert.throws(()=>surface.prepareUpdate(grid,w,h,0),/disposed/);
});

test('invalid grids and dirty bounds reject before replacing a surface',()=>{
 const grid=new Int16Array(25),surface=new WaterSurface(grid,4,4,0);
 assert.throws(()=>surface.prepareUpdate(new Int16Array(2),4,4,0));
 assert.throws(()=>surface.prepareUpdate(grid,4,4,0,{x0:3,y0:0,x1:2,y1:0}));
 assert.throws(()=>surface.prepareUpdate(grid,4,4,0,{x0:0,y0:0,x1:5,y1:0}));
 assert.equal(surface.children.length,0);surface.dispose();
});
