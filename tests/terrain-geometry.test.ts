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
