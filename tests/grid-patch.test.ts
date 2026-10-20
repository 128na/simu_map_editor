import {test} from 'node:test';
import assert from 'node:assert/strict';
import {patchGrid,waterChanged} from '../src/grid-patch.ts';
import {toGrid,DEFAULT_PROFILE,applyBrushIncremental,type Heightmap} from '../src/terrain.ts';

test('local grid patches match full normalization including duplicated outer vertices',()=>{
 const p={...DEFAULT_PROFILE,mode:'clamp' as const};
 let map:Heightmap={width:24,height:18,heights:new Float32Array(24*18)},grid=toGrid(map,p);
 for(const [x,y,tool] of [[23,17,'raise'],[0,0,'lower'],[12,9,'flatten']] as const){
  const r=applyBrushIncremental(map,p,{x,y,tool,radius:2,amount:2,...(tool==='flatten'?{target:2}:{})});
  assert.equal(r.incremental,true);const patch=patchGrid(grid,r.map,r.bounds!);
  assert.deepEqual(patch.grid,toGrid(r.map,p));grid=patch.grid;map=r.map;
 }
});
test('water reuse covers dry, submerged, coastline and exact sea-level transitions',()=>{
 const w=3,h=2,a=new Int16Array(12).fill(2),b=a.slice();b[5]=3;
 assert.equal(waterChanged(a,b,w,h,0,{x0:1,y0:1,x1:1,y1:1}),false);
 const wet=new Int16Array(12).fill(-2),deep=wet.slice();deep[5]=-3;
 assert.equal(waterChanged(wet,deep,w,h,0,{x0:1,y0:1,x1:1,y1:1}),false);
 const coast=a.slice();coast[5]=-1;
 assert.equal(waterChanged(a,coast,w,h,0,{x0:1,y0:1,x1:1,y1:1}),true);
 const sea=wet.slice();sea[5]=0;
 assert.equal(waterChanged(wet,sea,w,h,0,{x0:1,y0:1,x1:1,y1:1}),true);
});
