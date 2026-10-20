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
