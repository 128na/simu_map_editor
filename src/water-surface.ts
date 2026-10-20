import * as THREE from 'three';
import {createWaterMesh,WATER_GEOMETRY_BUDGET_BYTES} from './water.ts';
import type {TerrainDirtyBounds} from './terrain-geometry.ts';

type WaterMesh=THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;
interface Chunk {x0:number;y0:number;x1:number;y1:number;mesh:WaterMesh|null}
const CHUNK_SIZE=256;
const bytes=(mesh:WaterMesh|null)=>mesh?Object.values(mesh.geometry.attributes).reduce((sum,a)=>sum+a.array.byteLength,0):0;
const release=(mesh:WaterMesh|null)=>{if(mesh){mesh.geometry.dispose();mesh.material.dispose();}};
const budgetError=()=>new Error('海岸線が複雑すぎるため、水面メッシュのメモリ上限（CPU配列16 MiB）を超えます。画像を縮小するか、海面設定を変更してください。');

/** Exact shoreline clipping, partitioned so an edit rebuilds only nearby cells. */
export class WaterSurface extends THREE.Group {
 private chunks:Chunk[]=[];
 private width=0;
 private height=0;
 private sea=0;
 private generation=0;
 private disposed=false;
 constructor(grid:Int16Array,w:number,h:number,sea:number){
  super();
  const pending=this.prepareUpdate(grid,w,h,sea);pending.commit();
 }
 private build(grid:Int16Array,w:number,h:number,sea:number,c:Omit<Chunk,'mesh'>):Chunk{
  const cw=c.x1-c.x0,ch=c.y1-c.y0,local=new Int16Array((cw+1)*(ch+1));
  for(let y=0;y<=ch;y++)local.set(grid.subarray((c.y0+y)*(w+1)+c.x0,(c.y0+y)*(w+1)+c.x1+1),y*(cw+1));
  const mesh=createWaterMesh(local,cw,ch,sea);
  if(!mesh.geometry.getAttribute('position').count){release(mesh);return {...c,mesh:null};}
  // Bake world coordinates so the grid shader shares the terrain coordinate frame.
  mesh.geometry.translate(c.x0+(cw-w)/2,0,c.y0+(ch-h)/2);
  mesh.geometry.userData={x0:c.x0,y0:c.y0,x1:c.x1,y1:c.y1};
  return {...c,mesh};
 }
 /** Allocations and the aggregate budget check precede all visible mutation.
  * The caller must commit or dispose before preparing another update. */
 prepareUpdate(grid:Int16Array,w:number,h:number,sea:number,dirty?:TerrainDirtyBounds){
  if(this.disposed)throw new Error('Water surface is disposed');
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||grid.length!==(w+1)*(h+1)||!Number.isFinite(sea))throw new Error('Invalid water grid dimensions or sea level');
  if(dirty&&(![dirty.x0,dirty.x1,dirty.y0,dirty.y1].every(Number.isInteger)||dirty.x0<0||dirty.y0<0||dirty.x1>w||dirty.y1>h||dirty.x0>dirty.x1||dirty.y0>dirty.y1))throw new Error('Invalid water dirty bounds');
  const full=!dirty||w!==this.width||h!==this.height||sea!==this.sea;
  const next=full?[] as Chunk[]:this.chunks.slice();
  const targets:{index:number;bounds:Omit<Chunk,'mesh'>}[]=[];
  if(full){
   for(let y=0;y<h;y+=CHUNK_SIZE)for(let x=0;x<w;x+=CHUNK_SIZE)targets.push({index:targets.length,bounds:{x0:x,y0:y,x1:Math.min(w,x+CHUNK_SIZE),y1:Math.min(h,y+CHUNK_SIZE)}});
  }else{
   // A changed vertex contributes to cells on both sides of a chunk boundary.
   for(const [index,c] of this.chunks.entries())if(c.x1>dirty!.x0-1&&c.x0<=dirty!.x1&&c.y1>dirty!.y0-1&&c.y0<=dirty!.y1)targets.push({index,bounds:c});
  }
  const created:Chunk[]=[];
  let total=full?0:this.metrics.geometryBytes-targets.reduce((sum,t)=>sum+bytes(this.chunks[t.index].mesh),0);
  try{
   for(const t of targets){const chunk=this.build(grid,w,h,sea,t.bounds);created.push(chunk);next[t.index]=chunk;total+=bytes(chunk.mesh);if(total>WATER_GEOMETRY_BUDGET_BYTES)throw budgetError();}
  }catch(error){for(const c of created)release(c.mesh);throw error;}
  const generation=this.generation;
  let state:'pending'|'committed'|'disposed'='pending';
  return {
   commit:()=>{
    if(state!=='pending')return;
    if(this.disposed||generation!==this.generation){for(const c of created)release(c.mesh);state='disposed';throw new Error('Stale water update');}
    const old=full?this.chunks:targets.map(t=>this.chunks[t.index]);
    for(const c of old)if(c.mesh){this.remove(c.mesh);release(c.mesh);}
    for(const c of created)if(c.mesh)this.add(c.mesh);
    this.chunks=next;this.width=w;this.height=h;this.sea=sea;this.generation++;state='committed';
   },
   dispose:()=>{if(state==='pending'){for(const c of created)release(c.mesh);state='disposed';}}
  };
 }
 get materials(){return this.chunks.flatMap(c=>c.mesh?[c.mesh.material]:[]);}
 get metrics(){let geometryBytes=0,triangles=0;for(const c of this.chunks)if(c.mesh){geometryBytes+=bytes(c.mesh);triangles+=c.mesh.geometry.getAttribute('position').count/3;}return {geometryBytes,triangles};}
 dispose(){if(this.disposed)return;for(const c of this.chunks)release(c.mesh);this.clear();this.chunks=[];this.disposed=true;this.generation++;}
}
