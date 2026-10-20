import {inflateSync} from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHeightmap, exportBmp, exportPng } from '../src/codecs.ts';
import { DEFAULT_PROFILE, toGrid } from '../src/terrain.ts';
import { pngFixture, chunk, rleAbsoluteFixture } from './fixtures.ts';
const profile={...DEFAULT_PROFILE,mode:'clamp' as const};

test('PNG raw samples survive all five PNG filters, gamma metadata and opaque RGBA',async()=>{
  for(const channels of [1,3,4]) {
    const fixture=pngFixture(7,5,channels,true);
    const map=await decodeHeightmap(fixture.bytes,profile);
    assert.deepEqual(Array.from(map.heights),fixture.red.map(v=>Math.max(-12,Math.min(32,v-128))));
  }
});
test('BMP export preserves native grid across repeated imports including source edges',async()=>{
  const original={width:9,height:8,heights:Float32Array.from({length:72},(_,i)=>i===7?9:0)};
  const first=await decodeHeightmap(exportBmp(original,profile),profile);
  const second=await decodeHeightmap(exportBmp(first,profile),profile);
  assert.deepEqual(toGrid(first,profile),toGrid(original,profile));
  assert.deepEqual(toGrid(second,profile),toGrid(original,profile));
});
test('PPM does not consume a whitespace-valued first pixel after the header',async()=>{
  const bytes=Buffer.concat([Buffer.from('P6\n# comment\n1 1\n255\n'),Buffer.from([10,32,13])]);
  const map=await decodeHeightmap(bytes,profile);
  assert.deepEqual(Array.from(map.heights),[-12]);
  const raw={...profile,min:-127,max:125};
  assert.deepEqual(Array.from((await decodeHeightmap(bytes,raw)).heights),[-118]);
});
test('oversized PNG dimensions reject before attempting decompression',async()=>{
  const header=Buffer.alloc(13);header.writeUInt32BE(1000000);header.writeUInt32BE(1000000,4);header[8]=8;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header)]);
  await assert.rejects(decodeHeightmap(bytes,profile),/dimensions/);
});
test('unsupported transparency, truncation, corrupt CRC and wrong PPM depth reject',async()=>{
  await assert.rejects(decodeHeightmap(pngFixture(3,5,4,false,true).bytes,profile),/半透明/);
  const bytes=pngFixture(3,5).bytes;const corrupt=Buffer.from(bytes);corrupt[29]^=1;
  await assert.rejects(decodeHeightmap(corrupt,profile),/CRC/);
  await assert.rejects(decodeHeightmap(bytes.subarray(0,30),profile));
  await assert.rejects(decodeHeightmap(Buffer.from('P6\n1 1\n65535\n'),profile),/255/);
});

test('RLE8 absolute runs consume correct padding for odd and even lengths',async()=>{
  for(const width of [8,9]) {
    const fixture=rleAbsoluteFixture(width,8);
    const map=await decodeHeightmap(fixture.bytes,profile);
    assert.deepEqual(Array.from(map.heights),fixture.red.map(v=>Math.max(-12,Math.min(32,v-128))));
  }
});

test('PNG export emits exact grayscale samples and native-compatible heights across profiles',async()=>{
 const terrain=await import('../src/terrain.ts');
 for(const mode of ['linear','clamp','legacy-small','legacy-large'] as const)for(const factor of [1,2] as const)for(const maxSlope of [1,2] as const){
  const profile={...terrain.DEFAULT_PROFILE,mode,factor,maxSlope};
  const original={width:7,height:3,heights:Float32Array.from({length:21},(_,i)=>i*3-16.5)};
  const png=await exportPng(original,profile),view=new DataView(png.buffer);
  assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.equal(view.getUint32(16),7);assert.equal(view.getUint32(20),3);
  assert.deepEqual([...png.subarray(24,29)],[8,0,0,0,0]);
  const compressedLength=view.getUint32(33),raw=inflateSync(png.subarray(41,41+compressedLength));
  const samples=terrain.encodeSamples(original,profile);
  for(let y=0;y<3;y++){assert.equal(raw[y*8],0);assert.deepEqual([...raw.subarray(y*8+1,y*8+8)],[...samples.subarray(y*7,(y+1)*7)]);}
  const first=await decodeHeightmap(png,profile),again=await decodeHeightmap(await exportPng(first,profile),profile);
  assert.deepEqual(terrain.toGrid(first,profile),terrain.toGrid(original,profile));assert.deepEqual(terrain.toGrid(again,profile),terrain.toGrid(first,profile));
 }
});
