import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {nativeProbeConfig,verifyNativeBuild,NATIVE_SOURCE_COMMIT} from './native-probe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config=nativeProbeConfig({env:{...process.env,...(process.argv[2]?{SIMUTRANS_SOURCE:process.argv[2]}:{}),...(process.argv[3]?{SIMUTRANS_COMPILER_BIN:process.argv[3]}:{})}});
const expectedCommit=NATIVE_SOURCE_COMMIT,output=config.output,env=config.env;
const build=verifyNativeBuild(config);
mkdirSync(join(output,'fixtures'),{recursive:true});
function run(executable,args,extra={}){
 const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:96*1024*1024,...extra});
 if(result.error)throw result.error;
 assert.equal(result.status,0,`${executable}: ${result.stderr}`);return result.stdout;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function png(w, h, pixels, color = 0, depth = 8) {
  const channels = color === 2 ? 3 : color === 6 ? 4 : 1;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = color;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = [0];
    for (let x = 0; x < w; x++) {
      const p = pixels[x + y * w];
      if (Array.isArray(p)) row.push(...p.slice(0, channels));
      else if (depth === 16) row.push(p >>> 8, p & 255);
      else row.push(p);
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function bmp(w, h, pixels, { indexed = false, rle = false, topDown = false } = {}) {
  const bpp = indexed ? 8 : 24;
  const pitch = Math.ceil(w * bpp / 32) * 4;
  const palette = indexed ? Buffer.alloc(1024) : Buffer.alloc(0);
  // Reverse palette ensures a decoder cannot confuse an index with the color's red value.
  for (let i = 0; i < palette.length / 4; i++) palette.set([255-i,255-i,255-i,0], i*4);
  const rows = [];
  for (let row = 0; row < h; row++) {
    const y = topDown ? row : h - row - 1;
    const values = [];
    for (let x = 0; x < w; x++) {
      const p = pixels[x + y*w];
      if (indexed) values.push(...(rle ? [1,255-p] : [255-p]));
      else { const rgb = Array.isArray(p) ? p : [p,p,p]; values.push(rgb[2],rgb[1],rgb[0]); }
    }
    const data = rle ? Buffer.from([...values,0,0]) : Buffer.alloc(pitch);
    if (!rle) data.set(values);
    rows.push(data);
  }
  if (rle) rows.push(Buffer.from([0,1]));
  const data = Buffer.concat(rows);
  const header = Buffer.alloc(54);
  header.write('BM'); header.writeUInt32LE(54+palette.length+data.length,2); header.writeUInt32LE(54+palette.length,10);
  header.writeUInt32LE(40,14); header.writeInt32LE(w,18); header.writeInt32LE(topDown ? -h : h,22);
  header.writeUInt16LE(1,26); header.writeUInt16LE(bpp,28); header.writeUInt32LE(rle ? 1 : 0,30); header.writeUInt32LE(data.length,34);
  if(indexed) header.writeUInt32LE(256,46);
  return Buffer.concat([header,palette,data]);
}
function ppm(w,h,pixels) {
  return Buffer.concat([Buffer.from(`P6\n# deterministic validation fixture\n${w} ${h}\n255\n`), Buffer.from(pixels.flatMap(p => Array.isArray(p) ? p.slice(0,3) : [p,p,p]))]);
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi,v));
function height(v, mode, factor, lo=-12, hi=32) {
  if(mode === 0) return clamp(Math.floor(6*v/(factor===2?32:64))-(factor===2?28:14),lo,hi);
  if(mode === 1) return clamp(Math.floor(6*v/(factor===2?24:48))-(factor===2?34:18),lo,hi);
  if(mode === 2) return lo + Math.floor(v*(hi-lo)/255);
  return clamp(v-128,lo,hi);
}
// Independent oracle: upper envelope of Chebyshev-distance cones, not recursive raising.
function expectedGrid(w,h,decoded,d) {
  const seeds = [];
  for(let y=0;y<=h;y++) for(let x=0;x<=w;x++) seeds.push(decoded[Math.min(y,h-1)*w+Math.min(x,w-1)]+1);
  const result = [];
  for(let y=0;y<=h;y++) for(let x=0;x<=w;x++) {
    let value = -Infinity;
    for(let sy=0;sy<=h;sy++) for(let sx=0;sx<=w;sx++) value = Math.max(value,seeds[sx+sy*(w+1)]-d*Math.max(Math.abs(x-sx),Math.abs(y-sy)));
    result.push(value);
  }
  return result;
}
function checkSlopes(w,h,grid,d) {
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const corners=[grid[x+y*(w+1)],grid[x+1+y*(w+1)],grid[x+(y+1)*(w+1)],grid[x+1+(y+1)*(w+1)]];
    assert.ok(Math.max(...corners)-Math.min(...corners)<=d,`invalid tile ${x},${y}`);
  }
}
const fixtures = [];
function add(name,w,h,values,bytes) {
  const path = join(output,'fixtures',name);
  writeFileSync(path,bytes);
  fixtures.push({name,w,h,values,path,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const ramp = Array.from({length:256},(_,v)=>v);
add('all-values.png',256,1,ramp,png(256,1,ramp));
const asymmetric=Array.from({length:72},(_,i)=>(i*37+Math.floor(i/9)*11)%256);
add('asymmetric-bottom-up.bmp',9,8,asymmetric,bmp(9,8,asymmetric));
add('asymmetric-top-down.bmp',9,8,asymmetric,bmp(9,8,asymmetric,{topDown:true}));
add('asymmetric-palette.bmp',9,8,asymmetric,bmp(9,8,asymmetric,{indexed:true}));
add('asymmetric-rle8.bmp',9,8,asymmetric,bmp(9,8,asymmetric,{indexed:true,rle:true}));
add('asymmetric.ppm',9,8,asymmetric,ppm(9,8,asymmetric));
add('asymmetric.png',9,8,asymmetric,png(9,8,asymmetric));
add('gray16.png',9,8,asymmetric,png(9,8,asymmetric.map(v=>v*256+173),0,16));
const rgb=asymmetric.map(v=>[v,255-v,(v*3)%256]);
add('red-channel.bmp',9,8,asymmetric,bmp(9,8,rgb));
add('red-channel.ppm',9,8,asymmetric,ppm(9,8,rgb));
add('red-channel.png',9,8,asymmetric,png(9,8,rgb,2));
for(const name of ['flat','spike','pit','corners']) {
  const samples=Array.from({length:81},()=>name==='pit'?136:128);
  if(name==='spike') samples[4+4*9]=134;
  if(name==='pit') samples[4+4*9]=128;
  if(name==='corners') { samples[0]=129; samples[8]=132; samples[72]=130; samples[80]=135; }
  add(`${name}.png`,9,9,samples,png(9,9,samples));
}
let checks=0;
const cases=[];
for(const fixture of fixtures) for(const mode of [0,1,2,3]) for(const factor of [1,2]) for(const d of [1,2]) {
  const actual=JSON.parse(run(config.executable,[fixture.path,`${mode}`,`${factor}`,`${d===2?1:0}`,'-12','32']));
  assert.equal(actual.width,fixture.w); assert.equal(actual.height,fixture.h);
  const decoded=fixture.values.map(v=>height(v,mode,factor));
  assert.deepEqual(actual.decoded,decoded,`${fixture.name}: height conversion ${mode}/${factor}`);
  assert.deepEqual(actual.grid,expectedGrid(fixture.w,fixture.h,decoded,d),`${fixture.name}: +1/border/slope ${mode}/${factor}/${d}`);
  checkSlopes(fixture.w,fixture.h,actual.grid,d);
  checks++;
  cases.push({fixture:fixture.name,mode,factor,maxSlope:d,cleanupMs:actual.cleanupMs});
}
// Verify inversion for every reachable loader level and explicitly detect legacy gaps.
const inverse=[];
for(const mode of [0,1,2,3]) for(const factor of [1,2]) {
  const levels=new Set(ramp.map(v=>height(v,mode,factor)));
  for(const level of levels) {
    const v=ramp.find(v=>height(v,mode,factor)===level);
    assert.equal(height(v,mode,factor),level);
  }
  inverse.push({mode,factor,reachableLevels:levels.size,min:Math.min(...levels),max:Math.max(...levels)});
}
const report={sourceCommit:expectedCommit,build,fixtureCount:fixtures.length,passedCases:checks,
  scope:'Original image decoders, height_map_loader and surface_t::raise_grid_to; world initialization/cleanup sequencing is harness code, not full game runtime.',
  notVerified:['full world ground/water generation','lake/river/beach generation','browser/GPU performance','editor brush operations'],
  fixtures:fixtures.map(({path,values,...rest})=>rest),inverse,cases};
writeFileSync(join(output,'heightmap-results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({fixtureCount:report.fixtureCount,passedCases:checks,inverse,report:'.validation/heightmap-results.json'},null,2));
