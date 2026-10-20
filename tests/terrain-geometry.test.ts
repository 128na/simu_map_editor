import type {BufferAttribute} from 'three';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {terrainGeometry} from '../src/terrain-geometry.ts';

test('partial updates preserve buffers and match full normals at corners, borders and interior',()=>{
 const w=13,h=9;let grid=Int16Array.from({length:(w+1)*(h+1)},(_,i)=>Math.round(3*Math.sin(i)));
 const geometry=terrainGeometry(grid,w,h,0),positions=geometry.getAttribute('position').array,indices=geometry.getIndex()!.array;
 for(const [x,y] of [[0,0],[w,h],[4,3],[w,0],[0,h]]){
  const next=grid.slice();next[y*(w+1)+x]+=2;
  const updated=terrainGeometry(next,w,h,0,geometry,grid),full=terrainGeometry(next,w,h,0);
  assert.equal(updated,geometry);assert.equal(updated.getAttribute('position').array,positions);assert.equal(updated.getIndex()!.array,indices);
  for(const name of ['position','color','normal']){
   const actual=updated.getAttribute(name).array,expected=full.getAttribute(name).array;
   for(let i=0;i<actual.length;i++)assert.ok(Math.abs(actual[i]-expected[i])<1e-6,`${name}/${i}`);
  }
  full.dispose();grid=next;
 }
 const recolored=terrainGeometry(grid,w,h,4,geometry,grid,0),fresh=terrainGeometry(grid,w,h,4);
 assert.deepEqual(recolored.getAttribute('color').array,fresh.getAttribute('color').array);
 assert.notEqual(terrainGeometry(new Int16Array(15*10),14,9,0,geometry,grid),geometry);
});

test('edits before a render preserve every pending GPU upload range',()=>{
 const w=32,h=32,a=new Int16Array((w+1)*(h+1)),g=terrainGeometry(a,w,h,0);
 for(const name of ['position','color','normal'])(g.getAttribute(name) as BufferAttribute).clearUpdateRanges();
 const b=a.slice();b[2*(w+1)+2]=1;terrainGeometry(b,w,h,0,g,a);
 const c=b.slice();c[28*(w+1)+28]=1;terrainGeometry(c,w,h,0,g,b);
 for(const name of ['position','color','normal'])for(const index of [2*(w+1)+2,28*(w+1)+28])
  assert.ok((g.getAttribute(name) as BufferAttribute).updateRanges.some(r=>r.start<=index*3&&r.start+r.count>=index*3+3),`${name}/${index}`);
});

test('explicit dirty bounds match full geometry and leave unrelated buffers untouched',()=>{
 const w=37,h=21;let grid=Int16Array.from({length:(w+1)*(h+1)},(_,i)=>(i*13)%7-3);
 const geometry=terrainGeometry(grid,w,h,0);
 for(const [x0,y0,x1,y1] of [[0,0,0,0],[w,h,w,h],[8,4,12,7],[0,9,1,12],[w-1,0,w,1]]){
  const before=Object.fromEntries(['position','color','normal'].map(name=>[name,geometry.getAttribute(name).array.slice()]));
  for(const name of ['position','color','normal'])(geometry.getAttribute(name) as BufferAttribute).clearUpdateRanges();
  const next=grid.slice();
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)next[y*(w+1)+x]+=2;
  terrainGeometry(next,w,h,0,geometry,grid,0,{x0,y0,x1,y1});
  const full=terrainGeometry(next,w,h,0);
  for(const name of ['position','color','normal']){
   const actual=geometry.getAttribute(name).array,expected=full.getAttribute(name).array,padding=name==='normal'?1:0;
   for(let y=0;y<=h;y++)for(let x=0;x<=w;x++)for(let c=0;c<3;c++){
    const i=(y*(w+1)+x)*3+c;
    assert.ok(Math.abs(actual[i]-expected[i])<1e-6,`${name}/${x}/${y}/${c}`);
    if(x<x0-padding||x>x1+padding||y<y0-padding||y>y1+padding)assert.equal(actual[i],before[name][i],`unrelated ${name}/${i}`);
   }
   for(const r of (geometry.getAttribute(name) as BufferAttribute).updateRanges){
    for(let i=r.start;i<r.start+r.count;i+=3){const vertex=i/3,x=vertex%(w+1),y=Math.floor(vertex/(w+1));assert.ok(x>=Math.max(0,x0-padding)&&x<=Math.min(w,x1+padding)&&y>=Math.max(0,y0-padding)&&y<=Math.min(h,y1+padding));}
   }
  }
  grid=next;full.dispose();
 }
 geometry.dispose();
});

test('sea and dimension changes ignore dirty bounds; dirty updates retain pending ranges',()=>{
 const w=8,h=5,a=new Int16Array((w+1)*(h+1)),geometry=terrainGeometry(a,w,h,-1),dirty={x0:1,y0:1,x1:1,y1:1};
 for(const name of ['position','color','normal'])(geometry.getAttribute(name) as BufferAttribute).clearUpdateRanges();
 const b=a.slice();b[w+2]=3;terrainGeometry(b,w,h,-1,geometry,a,-1,dirty);
 const c=b.slice();c[4*(w+1)+6]=2;terrainGeometry(c,w,h,-1,geometry,b,-1,{x0:6,y0:4,x1:6,y1:4});
 for(const name of ['position','color','normal'])for(const index of [w+2,4*(w+1)+6])assert.ok((geometry.getAttribute(name) as BufferAttribute).updateRanges.some(r=>r.start<=index*3&&r.start+r.count>=index*3+3));
 terrainGeometry(c,w,h,2,geometry,c,-1,dirty);
 const fresh=terrainGeometry(c,w,h,2);assert.deepEqual(geometry.getAttribute('color').array,fresh.getAttribute('color').array);
 const resized=terrainGeometry(new Int16Array(4),1,1,0,geometry,c,2,dirty);
 assert.notEqual(resized,geometry);assert.equal(resized.getAttribute('position').count,4);
 geometry.dispose();fresh.dispose();resized.dispose();
});
