import * as THREE from 'three';
import type {TerrainDirtyBounds} from './terrain-geometry.ts';

export interface TerrainSurfaceOptions {chunkSize?:number;cellBudget?:number}
interface Chunk {x0:number;y0:number;x1:number;y1:number;stride:number;mesh:THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>}

/** Bounded overview meshes; editing and picking continue to use the full grid. */
export class TerrainSurface extends THREE.Group {
 private readonly material:THREE.MeshStandardMaterial;
 private readonly chunkSize:number;
 private readonly cellBudget:number;
 private chunks:Chunk[]=[];
 private grid:Int16Array=new Int16Array();
 private width=0;
 private height=0;
 private sea=0;
 private stride=1;
 private focusPoint:{x:number;y:number;radius:number}|null=null;

 constructor(material:THREE.MeshStandardMaterial,options:TerrainSurfaceOptions={}){
  super();this.material=material;this.chunkSize=options.chunkSize??256;this.cellBudget=options.cellBudget??1048576;
  if(!Number.isInteger(this.chunkSize)||this.chunkSize<4||this.chunkSize>256||(this.chunkSize&(this.chunkSize-1))||!Number.isInteger(this.cellBudget)||this.cellBudget<1)throw new Error('Invalid terrain surface budget');
 }

 private overviewStride(w:number,h:number){
  const count=(length:number,stride:number)=>Math.floor(length/this.chunkSize)*Math.ceil(this.chunkSize/stride)+Math.ceil((length%this.chunkSize)/stride);
  let stride=1;
  while(count(w,stride)*count(h,stride)>this.cellBudget&&stride<this.chunkSize)stride*=2;
  if(count(w,stride)*count(h,stride)>this.cellBudget)throw new Error('Terrain overview exceeds the display cell budget');
  return stride;
 }
 private focused<T extends Pick<Chunk,'x0'|'y0'|'x1'|'y1'>>(chunks:T[],stride=this.stride){
  const selected=new Set<T>();const p=this.focusPoint;if(!p||stride===1)return selected;
  const distance=(c:T)=>Math.hypot(Math.max(c.x0-p.x,0,p.x-c.x1),Math.max(c.y0-p.y,0,p.y-c.y1));
  for(const chunk of chunks.filter(c=>distance(c)<=p.radius).sort((a,b)=>distance(a)-distance(b)).slice(0,4))selected.add(chunk);
  return selected;
 }
 private geometry(c:Pick<Chunk,'x0'|'y0'|'x1'|'y1'>,stride:number,grid=this.grid,w=this.width,h=this.height,sea=this.sea){
  const axis=(lo:number,hi:number)=>{const values:number[]=[];for(let v=lo;v<hi;v+=stride)values.push(v);values.push(hi);return values;};
  const xs=axis(c.x0,c.x1),ys=axis(c.y0,c.y1),cols=xs.length,rows=ys.length;
  const topCount=cols*rows,edgeCount=2*(cols+rows-2),vertexCount=topCount+edgeCount*2;
  const positions=new Float32Array(vertexCount*3),colors=new Float32Array(vertexCount*3),normals=new Float32Array(vertexCount*3);
  const indices=new Uint32Array(((cols-1)*(rows-1)+edgeCount)*6),palette=new Map<number,THREE.Color>();
  const color=(z:number)=>{let value=palette.get(z);if(!value){value=new THREE.Color().setHSL(z<=sea?.13:.29-Math.max(0,z)*.003,z<=sea?.24:.24,z<=sea?.32:.36+Math.max(0,z)*.006);palette.set(z,value);}return value;};
  const sample=(x:number,y:number)=>grid[y*(w+1)+x];
  for(let yi=0;yi<rows;yi++)for(let xi=0;xi<cols;xi++){
   const x=xs[xi],y=ys[yi],i=yi*cols+xi,k=i*3,z=sample(x,y),rgb=color(z);
   positions[k]=x-w/2;positions[k+1]=z;positions[k+2]=y-h/2;colors[k]=rgb.r;colors[k+1]=rgb.g;colors[k+2]=rgb.b;
   // Full-grid derivatives make shared vertex normals independent of each LOD.
   const xl=Math.max(0,x-1),xr=Math.min(w,x+1),yt=Math.max(0,y-1),yb=Math.min(h,y+1);
   const nx=-(sample(xr,y)-sample(xl,y))/(xr-xl),nz=-(sample(x,yb)-sample(x,yt))/(yb-yt),len=Math.hypot(nx,1,nz);
   normals[k]=nx/len;normals[k+1]=1/len;normals[k+2]=nz/len;
  }
  let next=0;
  for(let y=0;y<rows-1;y++)for(let x=0;x<cols-1;x++){
   const a=y*cols+x,b=a+1,cc=a+cols,d=cc+1;indices.set([a,cc,b,b,cc,d],next);next+=6;
  }
  // Continuous vertical skirts hide T-junction cracks where overview/detail meet.
  // -256 is below every supported signed-byte terrain height and its +1 offset.
  const edges:number[][]=[xs.map((_,i)=>i),ys.slice(1).map((_,i)=>(i+1)*cols+cols-1),xs.slice(0,-1).map((_,i)=>(rows-1)*cols+cols-2-i),ys.slice(1,-1).map((_,i)=>(rows-2-i)*cols)];
  const perimeter=edges.flat();
  for(let i=0;i<perimeter.length;i++){
   const source=perimeter[i],top=topCount+i*2,bottom=top+1;
   positions.set(positions.subarray(source*3,source*3+3),top*3);positions.set([positions[source*3],-256,positions[source*3+2]],bottom*3);
   colors.set(colors.subarray(source*3,source*3+3),top*3);colors.set(colors.subarray(source*3,source*3+3),bottom*3);
   const n=i<cols?[0,0,-1]:i<cols+rows-1?[1,0,0]:i<2*cols+rows-2?[0,0,1]:[-1,0,0];normals.set(n,top*3);normals.set(n,bottom*3);
   const following=topCount+((i+1)%perimeter.length)*2;indices.set([top,following,bottom,following,following+1,bottom],next);next+=6;
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setIndex(new THREE.BufferAttribute(indices,1));
  geometry.computeBoundingBox();geometry.computeBoundingSphere();geometry.userData={x0:c.x0,y0:c.y0,x1:c.x1,y1:c.y1,stride,topVertexCount:topCount,topTriangles:(cols-1)*(rows-1)*2};return geometry;
 }

 update(grid:Int16Array,w:number,h:number,sea:number,dirty?:TerrainDirtyBounds):void {
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||grid.length!==(w+1)*(h+1)||!Number.isFinite(sea))throw new Error('Invalid terrain surface grid');
  const stride=this.overviewStride(w,h),resized=w!==this.width||h!==this.height;
  if(resized){
   const specs:Pick<Chunk,'x0'|'y0'|'x1'|'y1'>[]=[];
   for(let y=0;y<h;y+=this.chunkSize)for(let x=0;x<w;x+=this.chunkSize)specs.push({x0:x,y0:y,x1:Math.min(w,x+this.chunkSize),y1:Math.min(h,y+this.chunkSize)});
   const focus=this.focused(specs,stride),next:Chunk[]=[];
   try{for(const bounds of specs){const detail=focus.has(bounds)?1:stride;next.push({...bounds,stride:detail,mesh:new THREE.Mesh(this.geometry(bounds,detail,grid,w,h,sea),this.material)});}}
   catch(error){for(const chunk of next)chunk.mesh.geometry.dispose();throw error;}
   for(const chunk of this.chunks){this.remove(chunk.mesh);chunk.mesh.geometry.dispose();}
   this.chunks=next;for(const chunk of next)this.add(chunk.mesh);
  }else{
   const focus=this.focused(this.chunks,stride),changedSea=sea!==this.sea;
   const replacements:{chunk:Chunk;geometry:THREE.BufferGeometry;stride:number}[]=[];
   try{for(const chunk of this.chunks){
    const desired=focus.has(chunk)?1:stride;
    const affected=!dirty||changedSea||chunk.x0<=dirty.x1+1&&chunk.x1>=dirty.x0-1&&chunk.y0<=dirty.y1+1&&chunk.y1>=dirty.y0-1;
    if(chunk.stride!==desired||affected)replacements.push({chunk,geometry:this.geometry(chunk,desired,grid,w,h,sea),stride:desired});
   }}catch(error){for(const replacement of replacements)replacement.geometry.dispose();throw error;}
   for(const replacement of replacements){replacement.chunk.mesh.geometry.dispose();replacement.chunk.mesh.geometry=replacement.geometry;replacement.chunk.stride=replacement.stride;}
  }
  // Grid ownership changes only after every replacement allocation succeeds.
  this.grid=grid;this.width=w;this.height=h;this.sea=sea;this.stride=stride;
 }

 focus(x:number,y:number,radius=40):void {
  if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(radius)||radius<0)throw new Error('Invalid terrain focus');
  const previous=this.focusPoint;this.focusPoint={x,y,radius};try{this.refreshFocus();}catch(error){this.focusPoint=previous;throw error;}
 }
 clearFocus():void {const previous=this.focusPoint;this.focusPoint=null;try{this.refreshFocus();}catch(error){this.focusPoint=previous;throw error;}}
 private refreshFocus(){
  if(!this.chunks.length)return;
  const focused=this.focused(this.chunks),replacements:{chunk:Chunk;geometry:THREE.BufferGeometry;stride:number}[]=[];
  try{for(const chunk of this.chunks){const stride=focused.has(chunk)?1:this.stride;if(stride!==chunk.stride)replacements.push({chunk,geometry:this.geometry(chunk,stride),stride});}}
  catch(error){for(const replacement of replacements)replacement.geometry.dispose();throw error;}
  for(const replacement of replacements){replacement.chunk.mesh.geometry.dispose();replacement.chunk.mesh.geometry=replacement.geometry;replacement.chunk.stride=replacement.stride;}
 }
 get metrics(){let geometryBytes=0,triangles=0;for(const chunk of this.chunks){const geometry=chunk.mesh.geometry;geometryBytes+=geometry.index!.array.byteLength;for(const attribute of Object.values(geometry.attributes))geometryBytes+=attribute.array.byteLength;triangles+=geometry.index!.count/3;}return {geometryBytes,triangles,stride:this.stride,chunkCount:this.chunks.length};}
 dispose():void {for(const chunk of this.chunks){this.remove(chunk.mesh);chunk.mesh.geometry.dispose();}this.chunks=[];this.grid=new Int16Array();this.width=this.height=0;this.focusPoint=null;}
}
