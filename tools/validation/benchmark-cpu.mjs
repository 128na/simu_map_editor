import {performance} from 'node:perf_hooks';
import {mkdirSync,writeFileSync} from 'node:fs';
import {cpus,platform,arch} from 'node:os';
import assert from 'node:assert/strict';
import {applyBrush,DEFAULT_PROFILE} from '../../src/terrain.ts';

const samples=[];
for(const size of [256,512,1024])for(const tool of ['raise','lower','flatten']){
 const ms=[];
 for(let trial=0;trial<6;trial++){
  const map={width:size,height:size,heights:new Float32Array(size*size)};
  const start=performance.now();
  const result=applyBrush(map,DEFAULT_PROFILE,{x:size/2,y:size/2,radius:8,amount:1,tool,...(tool==='flatten'?{target:1}:{})});
  const elapsed=performance.now()-start;
  assert.equal(result.changed,197);
  if(trial>0)ms.push(elapsed);
 }
 const sorted=[...ms].sort((a,b)=>a-b);samples.push({size,tool,ms,medianMs:sorted[2]});
}
const result={node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,revision:process.env.GITHUB_SHA??null,samples};
mkdirSync('.validation',{recursive:true});writeFileSync('.validation/cpu-performance.json',JSON.stringify(result,null,2)+'\n');
console.table(samples.map(({size,tool,medianMs})=>({size,tool,medianMs:medianMs.toFixed(2)})));
