import * as THREE from 'three';
import type {TerrainDirtyBounds} from './terrain-geometry.ts';

export interface TerrainSurfaceOptions {chunkSize?:number;cellBudget?:number}
interface Chunk {x0:number;y0:number;x1:number;y1:number;stride:number;mesh:THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>}

/** Bounded overview meshes; editing and picking continue to use the full grid. */
export class TerrainSurface extends THREE.Group {
 private readonly material:THREE.MeshStandardMaterial;
 private readonly chunkSize:number;
 private cellBudget:number;
 private chunks:Chunk[]=[];
 private retained:Chunk[]=[];
 private readonly retainedLimit=12;
 private grid:Int16Array=new Int16Array();
 private width=0;
 private height=0;
 private sea=0;
 private stride=1;
 private viewState:{frustum:THREE.Frustum;position:THREE.Vector3;projectionScale:number;perspective:boolean}|null=null;
 private focusPoint:{x:number;y:number;radius:number}|null=null;

 constructor(material:THREE.MeshStandardMaterial,options:TerrainSurfaceOptions={}){
  super();this.material=material;this.chunkSize=options.chunkSize??256;this.cellBudget=options.cellBudget??1048576;
  if(!Number.isInteger(this.chunkSize)||this.chunkSize<4||this.chunkSize>256||(this.chunkSize&(this.chunkSize-1))||!Number.isInteger(this.cellBudget)||this.cellBudget<1||this.cellBudget>16777216)throw new Error('Invalid terrain surface budget');
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
 /** Allocate regular cells across the visible map, rather than around the mouse.
  * Full-resolution seam vertices are a separate bounded per-chunk overhead. */
 private desiredStrides<T extends Pick<Chunk,'x0'|'y0'|'x1'|'y1'>>(chunks:T[],w:number,h:number,stride:number,retained:Pick<Chunk,'x0'|'y0'|'x1'|'y1'>[]=this.retained):Map<T,number>{
  const focused=this.focused(chunks,stride),result=new Map<T,number>();
  if(!this.viewState){
   for(const chunk of chunks)result.set(chunk,focused.has(chunk)||retained.includes(chunk)?1:stride);
   return result;
  }
  const state=this.viewState,box=new THREE.Box3(),center=new THREE.Vector3();
  const count=(c:T,s:number)=>Math.ceil((c.x1-c.x0)/s)*Math.ceil((c.y1-c.y0)/s);
  const candidates:{chunk:T;stride:number;cells:number;weight:number;order:number}[]=[];
  let total=0;
  for(const chunk of chunks){
   const cells=count(chunk,this.chunkSize);total+=cells;result.set(chunk,this.chunkSize);
   box.min.set(chunk.x0-w/2,-256,chunk.y0-h/2);box.max.set(chunk.x1-w/2,256,chunk.y1-h/2);
   if(!state.frustum.intersectsBox(box))continue;
   box.getCenter(center);
   const distance=Math.max(1,state.position.distanceTo(center));
   const pixelScale=state.perspective?state.projectionScale/distance:state.projectionScale;
   const area=Math.max(1e-9,(chunk.x1-chunk.x0)*(chunk.y1-chunk.y0)*pixelScale*pixelScale);
   // Editing preferences bias quality locally, but cannot consume extra cells.
   const weight=area*(focused.has(chunk)?2:retained.includes(chunk)?1.25:1);
   candidates.push({chunk,stride:this.chunkSize,cells,weight,order:result.size});
  }
  if(total>this.cellBudget)throw new Error('Terrain chunks exceed the display cell budget');
  // Largest projected cells are refined first. At most log2(chunkSize) refinements
  // per chunk; selection never allocates geometry until the final plan is known.
  type Candidate=typeof candidates[number];
  const higher=(a:Candidate,b:Candidate)=>a.weight/a.cells>b.weight/b.cells||a.weight/a.cells===b.weight/b.cells&&a.order<b.order;
  const heap:Candidate[]=[];
  const push=(item:Candidate)=>{let at=heap.length;heap.push(item);while(at){const parent=(at-1)>>1;if(!higher(item,heap[parent]))break;heap[at]=heap[parent];at=parent;}heap[at]=item;};
  const pop=()=>{const first=heap[0],last=heap.pop()!;if(heap.length){let at=0;while(at*2+1<heap.length){let child=at*2+1;if(child+1<heap.length&&higher(heap[child+1],heap[child]))child++;if(!higher(heap[child],last))break;heap[at]=heap[child];at=child;}heap[at]=last;}return first;};
  for(const item of candidates)push(item);
  while(heap.length){
   const item=pop();if(item.stride===1)continue;
   const nextStride=item.stride/2,newCells=count(item.chunk,nextStride),extra=newCells-item.cells;
   if(total+extra>this.cellBudget)continue;
   total+=extra;item.stride=nextStride;item.cells=newCells;result.set(item.chunk,nextStride);if(nextStride>1)push(item);
  }
  return result;
 }
 configure(options:{cellBudget:number}):void {
  if(!Number.isInteger(options.cellBudget)||options.cellBudget<1||options.cellBudget>16777216)throw new Error('Invalid terrain surface budget');
  if(options.cellBudget===this.cellBudget)return;
  const previous=this.cellBudget,previousStride=this.stride;
  this.cellBudget=options.cellBudget;
  try{if(this.width&&this.height)this.stride=this.overviewStride(this.width,this.height);this.refreshFocus();}
  catch(error){this.cellBudget=previous;this.stride=previousStride;throw error;}
 }
 /** Call after a completed/debounced camera move or resize, not each frame. */
 setView(camera:THREE.Camera,viewportHeight:number):void {
  if(!Number.isFinite(viewportHeight)||viewportHeight<=0)throw new Error('Invalid terrain viewport height');
  camera.updateMatrixWorld();
  const matrix=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  const next={frustum:new THREE.Frustum().setFromProjectionMatrix(matrix),position:camera.getWorldPosition(new THREE.Vector3()),projectionScale:Math.abs(camera.projectionMatrix.elements[5])*viewportHeight/2,perspective:(camera as THREE.PerspectiveCamera).isPerspectiveCamera===true};
  const previous=this.viewState;this.viewState=next;
  try{this.refreshFocus();}catch(error){this.viewState=previous;throw error;}
 }
 clearView():void {const previous=this.viewState;this.viewState=null;try{this.refreshFocus();}catch(error){this.viewState=previous;throw error;}}
 private geometry(c:Pick<Chunk,'x0'|'y0'|'x1'|'y1'>,stride:number,grid=this.grid,w=this.width,h=this.height,sea=this.sea){
  const axis=(lo:number,hi:number)=>{const values:number[]=[];for(let v=lo;v<hi;v+=stride)values.push(v);values.push(hi);return values;};
  const xs=axis(c.x0,c.x1),ys=axis(c.y0,c.y1),cols=xs.length,rows=ys.length,regularCount=cols*rows;
  const xIndices=new Map(xs.map((x,i)=>[x,i])),yIndices=new Map(ys.map((y,i)=>[y,i]));
  const extra:number[]=[],extraIndices=new Map<string,number>();
  const vertex=(x:number,y:number)=>{
   const xi=xIndices.get(x),yi=yIndices.get(y);if(xi!==undefined&&yi!==undefined)return yi*cols+xi;
   const key=`${x},${y}`;let index=extraIndices.get(key);
   if(index===undefined){index=regularCount+extra.length/2;extra.push(x,y);extraIndices.set(key,index);}return index;
  };
  // Every chunk boundary uses the identical one-tile polyline at every LOD.
  // Only coarse boundary cells need extra triangles; there are no deep skirts.
  const regularCellCount=(cols-1)*(rows-1);
  const indices=new Uint32Array(regularCellCount*6+12*(c.x1-c.x0+c.y1-c.y0)+48);let next=0;
  for(let yi=0;yi<rows-1;yi++)for(let xi=0;xi<cols-1;xi++){
   const x0=xs[xi],x1=xs[xi+1],y0=ys[yi],y1=ys[yi+1];
   if(stride===1||xi>0&&xi<cols-2&&yi>0&&yi<rows-2){
    const a=yi*cols+xi,b=a+1,cc=a+cols,d=cc+1;indices.set([a,cc,b,b,cc,d],next);next+=6;continue;
   }
   const perimeter:number[]=[vertex(x0,y0)];
   if(xi===0)for(let y=y0+1;y<y1;y++)perimeter.push(vertex(x0,y));
   perimeter.push(vertex(x0,y1));
   if(yi===rows-2)for(let x=x0+1;x<x1;x++)perimeter.push(vertex(x,y1));
   perimeter.push(vertex(x1,y1));
   if(xi===cols-2)for(let y=y1-1;y>y0;y--)perimeter.push(vertex(x1,y));
   perimeter.push(vertex(x1,y0));
   if(yi===0)for(let x=x1-1;x>x0;x--)perimeter.push(vertex(x,y0));
   const center=vertex((x0+x1)/2,(y0+y1)/2);
   for(let i=0;i<perimeter.length;i++){indices.set([center,perimeter[i],perimeter[(i+1)%perimeter.length]],next);next+=3;}
  }
  const vertexCount=regularCount+extra.length/2;
  const positions=new Float32Array(vertexCount*3),colors=new Float32Array(vertexCount*3),normals=new Float32Array(vertexCount*3),palette=new Map<number,THREE.Color>();
  const color=(z:number)=>{let value=palette.get(z);if(!value){value=new THREE.Color().setHSL(z<=sea?.13:.29-Math.max(0,z)*.003,z<=sea?.24:.24,z<=sea?.32:.36+Math.max(0,z)*.006);palette.set(z,value);}return value;};
  const sample=(x:number,y:number)=>this.sample(grid,w,h,x,y);
  for(let i=0;i<vertexCount;i++){
   const x=i<regularCount?xs[i%cols]:extra[(i-regularCount)*2],y=i<regularCount?ys[Math.floor(i/cols)]:extra[(i-regularCount)*2+1],k=i*3,z=sample(x,y),rgb=color(z);
   positions[k]=x-w/2;positions[k+1]=z;positions[k+2]=y-h/2;colors[k]=rgb.r;colors[k+1]=rgb.g;colors[k+2]=rgb.b;
   const xl=Math.max(0,x-1),xr=Math.min(w,x+1),yt=Math.max(0,y-1),yb=Math.min(h,y+1);
   const nx=-(sample(xr,y)-sample(xl,y))/(xr-xl),nz=-(sample(x,yb)-sample(x,yt))/(yb-yt),len=Math.hypot(nx,1,nz);
   normals[k]=nx/len;normals[k+1]=1/len;normals[k+2]=nz/len;
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));geometry.setAttribute('color',new THREE.BufferAttribute(colors,3).setUsage(THREE.DynamicDrawUsage));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3).setUsage(THREE.DynamicDrawUsage));geometry.setIndex(new THREE.BufferAttribute(indices.slice(0,next),1));
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  geometry.userData={x0:c.x0,y0:c.y0,x1:c.x1,y1:c.y1,stride,topVertexCount:vertexCount,topTriangles:next/3,regularCellCount,xs,ys,extra};return geometry;
 }
 private sample(grid:Int16Array,w:number,h:number,x:number,y:number){
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(w,x0+1),y1=Math.min(h,y0+1),tx=x-x0,ty=y-y0;
  if(tx===0&&ty===0)return grid[y0*(w+1)+x0];
  const a=grid[y0*(w+1)+x0]*(1-tx)+grid[y0*(w+1)+x1]*tx,b=grid[y1*(w+1)+x0]*(1-tx)+grid[y1*(w+1)+x1]*tx;
  return a*(1-ty)+b*ty;
 }

 /** Update sampled heights/colors and full-grid derivatives, including seams. */
 private patch(chunk:Chunk,grid:Int16Array,w:number,h:number,dirty:TerrainDirtyBounds):void {
  const geometry=chunk.mesh.geometry,positions=geometry.getAttribute('position') as THREE.BufferAttribute,colors=geometry.getAttribute('color') as THREE.BufferAttribute,normals=geometry.getAttribute('normal') as THREE.BufferAttribute;
  const {xs,ys,extra}=geometry.userData as {xs:number[];ys:number[];extra:number[]};
  const cols=xs.length,palette=new Map<number,THREE.Color>(),bounds=geometry.boundingBox!;let expanded=false;
  const color=(z:number)=>{let c=palette.get(z);if(!c){c=new THREE.Color().setHSL(z<=this.sea?.13:.29-Math.max(0,z)*.003,z<=this.sea?.24:.24,z<=this.sea?.32:.36+Math.max(0,z)*.006);palette.set(z,c);}return c;};
  const sample=(x:number,y:number)=>this.sample(grid,w,h,x,y);
  const update=(i:number,x:number,y:number,position:boolean)=>{
   if(position){const z=sample(x,y),c=color(z);if(z<bounds.min.y){bounds.min.y=z;expanded=true;}if(z>bounds.max.y){bounds.max.y=z;expanded=true;}positions.setY(i,z);colors.setXYZ(i,c.r,c.g,c.b);}
   const xl=Math.max(0,x-1),xr=Math.min(w,x+1),yt=Math.max(0,y-1),yb=Math.min(h,y+1);
   const nx=-(sample(xr,y)-sample(xl,y))/(xr-xl),nz=-(sample(x,yb)-sample(x,yt))/(yb-yt),len=Math.hypot(nx,1,nz);
   normals.setXYZ(i,nx/len,1/len,nz/len);
  };
  const x0=xs.findIndex(x=>x>=dirty.x0-1),y0=ys.findIndex(y=>y>=dirty.y0-1);
  if(x0>=0&&y0>=0)for(let yi=y0;yi<ys.length&&ys[yi]<=dirty.y1+1;yi++){
   const y=ys[yi];let normalStart=-1,normalEnd=-1,positionStart=-1,positionEnd=-1;
   for(let xi=x0;xi<cols&&xs[xi]<=dirty.x1+1;xi++){
    const x=xs[xi],i=yi*cols+xi,position=x>=dirty.x0&&x<=dirty.x1&&y>=dirty.y0&&y<=dirty.y1;
    update(i,x,y,position);if(position){if(positionStart<0)positionStart=i;positionEnd=i;}if(normalStart<0)normalStart=i;normalEnd=i;
   }
   if(positionStart>=0){positions.addUpdateRange(positionStart*3,(positionEnd-positionStart+1)*3);colors.addUpdateRange(positionStart*3,(positionEnd-positionStart+1)*3);}
   if(normalStart>=0)normals.addUpdateRange(normalStart*3,(normalEnd-normalStart+1)*3);
  }
  const regularCount=xs.length*ys.length;
  for(let n=0;n<extra.length;n+=2){
   const x=extra[n],y=extra[n+1];if(x<dirty.x0-2||x>dirty.x1+2||y<dirty.y0-2||y>dirty.y1+2)continue;
   const i=regularCount+n/2,position=x>=dirty.x0-1&&x<=dirty.x1+1&&y>=dirty.y0-1&&y<=dirty.y1+1;update(i,x,y,position);
   if(position){positions.addUpdateRange(i*3,3);colors.addUpdateRange(i*3,3);}normals.addUpdateRange(i*3,3);
  }
  if(expanded)bounds.getBoundingSphere(geometry.boundingSphere!);
  if(positions.updateRanges.length)positions.needsUpdate=true;
  if(colors.updateRanges.length)colors.needsUpdate=true;
  if(normals.updateRanges.length)normals.needsUpdate=true;
 }

 update(grid:Int16Array,w:number,h:number,sea:number,dirty?:TerrainDirtyBounds):void {
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||grid.length!==(w+1)*(h+1)||!Number.isFinite(sea))throw new Error('Invalid terrain surface grid');
  const stride=this.overviewStride(w,h),resized=w!==this.width||h!==this.height;
  if(resized){
   const specs:Pick<Chunk,'x0'|'y0'|'x1'|'y1'>[]=[];
   for(let y=0;y<h;y+=this.chunkSize)for(let x=0;x<w;x+=this.chunkSize)specs.push({x0:x,y0:y,x1:Math.min(w,x+this.chunkSize),y1:Math.min(h,y+this.chunkSize)});
   const desired=this.desiredStrides(specs,w,h,stride,[]),next:Chunk[]=[];
   try{for(const bounds of specs){const detail=desired.get(bounds)!;next.push({...bounds,stride:detail,mesh:new THREE.Mesh(this.geometry(bounds,detail,grid,w,h,sea),this.material)});}}
   catch(error){for(const chunk of next)chunk.mesh.geometry.dispose();throw error;}
   for(const chunk of this.chunks){this.remove(chunk.mesh);chunk.mesh.geometry.dispose();}
   this.chunks=next;this.retained=[];for(const chunk of next)this.add(chunk.mesh);
  }else{
   let retained=this.retained;
   if(dirty&&stride>1){
    retained=[...retained];
    for(const chunk of this.chunks)if(chunk.x0<=dirty.x1&&chunk.x1>=dirty.x0&&chunk.y0<=dirty.y1&&chunk.y1>=dirty.y0){retained=retained.filter(c=>c!==chunk);retained.push(chunk);}
    retained=retained.slice(-this.retainedLimit);
   }
   const desiredStrides=this.desiredStrides(this.chunks,w,h,stride,retained),changedSea=sea!==this.sea;
   const replacements:{chunk:Chunk;geometry:THREE.BufferGeometry;stride:number}[]=[],patches:Chunk[]=[];
   try{for(const chunk of this.chunks){
    const desired=desiredStrides.get(chunk)!;
    const affected=!dirty||changedSea||chunk.x0<=dirty.x1+1&&chunk.x1>=dirty.x0-1&&chunk.y0<=dirty.y1+1&&chunk.y1>=dirty.y0-1;
    if(chunk.stride!==desired||affected){
     if(dirty&&!changedSea&&chunk.stride===desired)patches.push(chunk);
     else replacements.push({chunk,geometry:this.geometry(chunk,desired,grid,w,h,sea),stride:desired});
    }
   }}catch(error){for(const replacement of replacements)replacement.geometry.dispose();throw error;}
   for(const replacement of replacements){replacement.chunk.mesh.geometry.dispose();replacement.chunk.mesh.geometry=replacement.geometry;replacement.chunk.stride=replacement.stride;}
   for(const chunk of patches)this.patch(chunk,grid,w,h,dirty!);
   this.retained=retained;
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
  const desired=this.desiredStrides(this.chunks,this.width,this.height,this.stride),replacements:{chunk:Chunk;geometry:THREE.BufferGeometry;stride:number}[]=[];
  try{for(const chunk of this.chunks){const stride=desired.get(chunk)!;if(stride!==chunk.stride)replacements.push({chunk,geometry:this.geometry(chunk,stride),stride});}}
  catch(error){for(const replacement of replacements)replacement.geometry.dispose();throw error;}
  for(const replacement of replacements){replacement.chunk.mesh.geometry.dispose();replacement.chunk.mesh.geometry=replacement.geometry;replacement.chunk.stride=replacement.stride;}
 }
 get metrics(){let geometryBytes=0,triangles=0,regularCells=0;for(const chunk of this.chunks){const geometry=chunk.mesh.geometry;geometryBytes+=geometry.index!.array.byteLength;for(const attribute of Object.values(geometry.attributes))geometryBytes+=attribute.array.byteLength;triangles+=geometry.index!.count/3;regularCells+=geometry.userData.regularCellCount;}return {geometryBytes,triangles,regularCells,cellBudget:this.cellBudget,viewAware:!!this.viewState,stride:this.stride,chunkCount:this.chunks.length,retainedDetailCount:this.retained.length,detailedChunkCount:this.chunks.filter(c=>c.stride===1).length};}
 dispose():void {for(const chunk of this.chunks){this.remove(chunk.mesh);chunk.mesh.geometry.dispose();}this.chunks=[];this.retained=[];this.grid=new Int16Array();this.width=this.height=0;this.focusPoint=null;this.viewState=null;}
}
