import type {DirtyBounds,Heightmap} from './terrain';

/** Only for source heights already proven reachable and eight-neighbor legal. */
export function patchGrid(previous:Int16Array,map:Heightmap,bounds:DirtyBounds){
 const {width:w,height:h}=map,grid=previous.slice();
 const dirty={...bounds,x1:bounds.x1===w-1?w:bounds.x1,y1:bounds.y1===h-1?h:bounds.y1};
 for(let y=dirty.y0;y<=dirty.y1;y++)for(let x=dirty.x0;x<=dirty.x1;x++)grid[y*(w+1)+x]=map.heights[Math.min(y,h-1)*w+Math.min(x,w-1)]+1;
 return {grid,dirty};
}
/** Fully dry or fully submerged cells retain exactly the same water coverage. */
export function waterChanged(previous:Int16Array,next:Int16Array,w:number,h:number,sea:number,dirty:DirtyBounds){
 for(let y=Math.max(0,dirty.y0-1);y<=Math.min(h-1,dirty.y1);y++)for(let x=Math.max(0,dirty.x0-1);x<=Math.min(w-1,dirty.x1);x++){
  const a=y*(w+1)+x,ids=[a,a+1,a+w+1,a+w+2];
  if(ids.every(i=>previous[i]>=sea&&next[i]>=sea)||ids.every(i=>previous[i]<sea&&next[i]<sea))continue;
  if(ids.some(i=>previous[i]!==next[i]))return true;
 }
 return false;
}

/** Exclusive render-grid transaction: retains only dirty rows for rollback.
 * Prepare water coverage before apply; no async work may run until commit/rollback. */
export function prepareGridPatch(grid:Int16Array,map:Heightmap,bounds:DirtyBounds){
 const {width:w,height:h}=map;
 const dirty={...bounds,x1:bounds.x1===w-1?w:bounds.x1,y1:bounds.y1===h-1?h:bounds.y1};
 const width=dirty.x1-dirty.x0+1,height=dirty.y1-dirty.y0+1;
 const before=new Int16Array(width*height),after=new Int16Array(width*height);
 for(let y=0;y<height;y++){
  before.set(grid.subarray((y+dirty.y0)*(w+1)+dirty.x0,(y+dirty.y0)*(w+1)+dirty.x0+width),y*width);
  for(let x=0;x<width;x++)after[y*width+x]=map.heights[Math.min(y+dirty.y0,h-1)*w+Math.min(x+dirty.x0,w-1)]+1;
 }
 const value=(x:number,y:number)=>x>=dirty.x0&&x<=dirty.x1&&y>=dirty.y0&&y<=dirty.y1?after[(y-dirty.y0)*width+x-dirty.x0]:grid[y*(w+1)+x];
 const write=(data:Int16Array)=>{for(let y=0;y<height;y++)grid.set(data.subarray(y*width,(y+1)*width),(y+dirty.y0)*(w+1)+dirty.x0);};
 let applied=false;
 return {grid,dirty,
  changesWater(sea:number){
   if(applied)throw new Error('Check water before applying the grid patch');
   for(let y=Math.max(0,dirty.y0-1);y<=Math.min(h-1,dirty.y1);y++)for(let x=Math.max(0,dirty.x0-1);x<=Math.min(w-1,dirty.x1);x++){
    const points=[[x,y],[x+1,y],[x,y+1],[x+1,y+1]];
    if(points.every(([a,b])=>grid[b*(w+1)+a]>=sea&&value(a,b)>=sea)||points.every(([a,b])=>grid[b*(w+1)+a]<sea&&value(a,b)<sea))continue;
    if(points.some(([a,b])=>grid[b*(w+1)+a]!==value(a,b)))return true;
   }
   return false;
  },
  apply(){write(after);applied=true;},
  rollback(){if(applied){write(before);applied=false;}}
 };
}
