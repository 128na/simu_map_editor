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
  const topCount=cols*rows;
  // Only internal boundaries need a skirt. Extending the map's outside edge to
  // -256 makes small maps look like deep blocks when viewed obliquely.
  const edges:{sources:number[];normal:number[]}[]=[];
  if(c.y0>0)edges.push({sources:xs.map((_,i)=>i),normal:[0,0,-1]});
  if(c.x1<w)edges.push({sources:ys.map((_,i)=>i*cols+cols-1),normal:[1,0,0]});
  if(c.y1<h)edges.push({sources:xs.map((_,i)=>(rows-1)*cols+cols-1-i),normal:[0,0,1]});
  if(c.x0>0)edges.push({sources:ys.map((_,i)=>(rows-1-i)*cols),normal:[-1,0,0]});
  const edgeVertices=edges.reduce((sum,e)=>sum+e.sources.length,0),edgeSegments=edges.reduce((sum,e)=>sum+e.sources.length-1,0);
  const vertexCount=topCount+edgeVertices*2;
  const positions=new Float32Array(vertexCount*3),colors=new Float32Array(vertexCount*3),normals=new Float32Array(vertexCount*3);
  const indices=new Uint32Array(((cols-1)*(rows-1)+edgeSegments)*6),palette=new Map<number,THREE.Color>();
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
  // Internal skirts cover coarse/detail T-junction cracks without an outside wall.
  const skirtSources=new Uint32Array(edgeVertices);let skirt=0;
  for(const edge of edges){
   for(let i=0;i<edge.sources.length;i++){
    const source=edge.sources[i],top=topCount+skirt*2,bottom=top+1;skirtSources[skirt++]=source;
    positions.set(positions.subarray(source*3,source*3+3),top*3);positions.set([positions[source*3],-256,positions[source*3+2]],bottom*3);
    colors.set(colors.subarray(source*3,source*3+3),top*3);colors.set(colors.subarray(source*3,source*3+3),bottom*3);
    normals.set(edge.normal,top*3);normals.set(edge.normal,bottom*3);
    if(i+1<edge.sources.length){const following=top+2;indices.set([top,following,bottom,following,following+1,bottom],next);next+=6;}
   }
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));geometry.setAttribute('color',new THREE.BufferAttribute(colors,3).setUsage(THREE.DynamicDrawUsage));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3).setUsage(THREE.DynamicDrawUsage));geometry.setIndex(new THREE.BufferAttribute(indices,1));
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  geometry.userData={x0:c.x0,y0:c.y0,x1:c.x1,y1:c.y1,stride,topVertexCount:topCount,topTriangles:(cols-1)*(rows-1)*2,xs,ys,skirtSources};return geometry;
 }

 /** Update only sampled heights/colors and their adjacent full-grid derivatives. */
 private patch(chunk:Chunk,grid:Int16Array,w:number,h:number,dirty:TerrainDirtyBounds):void {
  const geometry=chunk.mesh.geometry,positions=geometry.getAttribute('position') as THREE.BufferAttribute,colors=geometry.getAttribute('color') as THREE.BufferAttribute,normals=geometry.getAttribute('normal') as THREE.BufferAttribute;
  const {xs,ys,skirtSources,topVertexCount}=geometry.userData as {xs:number[];ys:number[];skirtSources:Uint32Array;topVertexCount:number};
  const cols=xs.length,palette=new Map<number,THREE.Color>(),bounds=geometry.boundingBox!;let expanded=false;
  const color=(z:number)=>{let c=palette.get(z);if(!c){c=new THREE.Color().setHSL(z<=this.sea?.13:.29-Math.max(0,z)*.003,z<=this.sea?.24:.24,z<=this.sea?.32:.36+Math.max(0,z)*.006);palette.set(z,c);}return c;};
  const sample=(x:number,y:number)=>grid[y*(w+1)+x];
  const x0=xs.findIndex(x=>x>=dirty.x0-1),y0=ys.findIndex(y=>y>=dirty.y0-1);
  if(x0>=0&&y0>=0)for(let yi=y0;yi<ys.length&&ys[yi]<=dirty.y1+1;yi++){
   const y=ys[yi];let normalStart=-1,normalEnd=-1,positionStart=-1,positionEnd=-1;
   for(let xi=x0;xi<cols&&xs[xi]<=dirty.x1+1;xi++){
    const x=xs[xi],i=yi*cols+xi;
    if(x>=dirty.x0&&x<=dirty.x1&&y>=dirty.y0&&y<=dirty.y1){
     const z=sample(x,y),c=color(z);if(z<bounds.min.y){bounds.min.y=z;expanded=true;}if(z>bounds.max.y){bounds.max.y=z;expanded=true;}positions.setY(i,z);colors.setXYZ(i,c.r,c.g,c.b);if(positionStart<0)positionStart=i;positionEnd=i;
    }
    const xl=Math.max(0,x-1),xr=Math.min(w,x+1),yt=Math.max(0,y-1),yb=Math.min(h,y+1);
    const nx=-(sample(xr,y)-sample(xl,y))/(xr-xl),nz=-(sample(x,yb)-sample(x,yt))/(yb-yt),len=Math.hypot(nx,1,nz);
    normals.setXYZ(i,nx/len,1/len,nz/len);if(normalStart<0)normalStart=i;normalEnd=i;
   }
   if(positionStart>=0){positions.addUpdateRange(positionStart*3,(positionEnd-positionStart+1)*3);colors.addUpdateRange(positionStart*3,(positionEnd-positionStart+1)*3);}
   if(normalStart>=0)normals.addUpdateRange(normalStart*3,(normalEnd-normalStart+1)*3);
  }
  for(let i=0;i<skirtSources.length;i++){
   const source=skirtSources[i],x=xs[source%cols],y=ys[Math.floor(source/cols)];
   if(x<dirty.x0||x>dirty.x1||y<dirty.y0||y>dirty.y1)continue;
   const top=topVertexCount+i*2,z=sample(x,y),c=color(z);
   positions.setY(top,z);colors.setXYZ(top,c.r,c.g,c.b);colors.setXYZ(top+1,c.r,c.g,c.b);
   positions.addUpdateRange(top*3,3);colors.addUpdateRange(top*3,6);
  }
  // Bounds may conservatively retain an old extremum, but never rescan all vertices.
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
   const focus=this.focused(specs,stride),next:Chunk[]=[];
   try{for(const bounds of specs){const detail=focus.has(bounds)?1:stride;next.push({...bounds,stride:detail,mesh:new THREE.Mesh(this.geometry(bounds,detail,grid,w,h,sea),this.material)});}}
   catch(error){for(const chunk of next)chunk.mesh.geometry.dispose();throw error;}
   for(const chunk of this.chunks){this.remove(chunk.mesh);chunk.mesh.geometry.dispose();}
   this.chunks=next;for(const chunk of next)this.add(chunk.mesh);
  }else{
   const focus=this.focused(this.chunks,stride),changedSea=sea!==this.sea;
   const replacements:{chunk:Chunk;geometry:THREE.BufferGeometry;stride:number}[]=[],patches:Chunk[]=[];
   try{for(const chunk of this.chunks){
    const desired=focus.has(chunk)?1:stride;
    const affected=!dirty||changedSea||chunk.x0<=dirty.x1+1&&chunk.x1>=dirty.x0-1&&chunk.y0<=dirty.y1+1&&chunk.y1>=dirty.y0-1;
    if(chunk.stride!==desired||affected){
     if(dirty&&!changedSea&&chunk.stride===desired)patches.push(chunk);
     else replacements.push({chunk,geometry:this.geometry(chunk,desired,grid,w,h,sea),stride:desired});
    }
   }}catch(error){for(const replacement of replacements)replacement.geometry.dispose();throw error;}
   for(const replacement of replacements){replacement.chunk.mesh.geometry.dispose();replacement.chunk.mesh.geometry=replacement.geometry;replacement.chunk.stride=replacement.stride;}
   for(const chunk of patches)this.patch(chunk,grid,w,h,dirty!);
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
