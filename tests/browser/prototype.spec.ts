import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pngFixture, chunk, rleAbsoluteFixture } from '../fixtures.ts';
const root=process.cwd(), output=resolve('.validation');
const modes=['legacy-small','legacy-large','linear','clamp'];
function native(path:string,profile:any):any {
  const result=spawnSync(join(output,'simutrans-probe.exe'),[path,`${modes.indexOf(profile.mode)}`,`${profile.factor}`,`${profile.maxSlope===2?1:0}`,`${profile.min}`,`${profile.max}`],{encoding:'utf8',timeout:10000,maxBuffer:10*1024*1024,env:{...process.env,PATH:'C:/msys64/mingw64/bin;'+process.env.PATH}});
  expect(result.status,result.stderr).toBe(0);return JSON.parse(result.stdout);
}
test.beforeEach(async({page})=>{
  await page.goto('/?validate=1');
  await page.waitForFunction(()=>!!(window as any).__validation);
});
test('browser codecs and terrain match real Simutrans loader and normalization',async({page},info)=>{
  const summary=JSON.parse(readFileSync(join(output,'heightmap-results.json'),'utf8'));
  let count=0;
  for(const fixture of summary.fixtures) {
    const bytes=readFileSync(join(output,'fixtures',fixture.name));
    if(fixture.name==='gray16.png') {
      const error=await page.evaluate(async(data)=>{const path='/src/codecs.ts';try{await(await import(path)).decodeHeightmap(Uint8Array.from(data),{mode:'linear',min:-12,max:32,factor:1,maxSlope:1,seaLevel:-2});return '';}catch(e){return String(e);}},Array.from(bytes));
      expect(error).toContain('8bit');continue;
    }
    for(const mode of modes)for(const factor of [1,2])for(const maxSlope of [1,2]) {
      const profile={mode,min:-12,max:32,factor,maxSlope,seaLevel:-2};
      const expected=native(join(output,'fixtures',fixture.name),profile);
      const actual=await page.evaluate(async({bytes,profile})=>{
        const codecPath='/src/codecs.ts',terrainPath='/src/terrain.ts';
        const codec=await import(codecPath),terrain=await import(terrainPath);
        const map=await codec.decodeHeightmap(Uint8Array.from(bytes),profile);
        const exported=codec.exportBmp(map,profile),again=await codec.decodeHeightmap(exported,profile);
        return {heights:Array.from(map.heights),grid:Array.from(terrain.toGrid(map,profile)),again:Array.from(terrain.toGrid(again,profile))};
      },{bytes:Array.from(bytes),profile});
      expect(actual.heights,fixture.name).toEqual(expected.decoded);
      expect(actual.grid,`${fixture.name}/${mode}/${factor}/${maxSlope}`).toEqual(expected.grid);
      expect(actual.again,fixture.name+' roundtrip').toEqual(expected.grid);count++;
    }
  }
  // Metadata and all five filter types are intentionally decoded as raw sample values.
  const gamma=pngFixture(7,5,3,true);const gammaPath=join(output,'fixtures','gamma-filters.png');writeFileSync(gammaPath,gamma.bytes);
  const p={mode:'clamp',min:-12,max:32,factor:1,maxSlope:1,seaLevel:-2};
  const expected=native(gammaPath,p);
  const actual=await page.evaluate(async({bytes,p})=>{const c='/src/codecs.ts',t='/src/terrain.ts';const codec=await import(c),terrain=await import(t);const m=await codec.decodeHeightmap(Uint8Array.from(bytes),p);return {heights:Array.from(m.heights),grid:Array.from(terrain.toGrid(m,p))};},{bytes:Array.from(gamma.bytes),p});
  expect(actual.heights).toEqual(expected.decoded);expect(actual.grid).toEqual(expected.grid);
  for(const width of [8,9]) {
    const fixture=rleAbsoluteFixture(width,8),path=join(output,'fixtures',`absolute-${width}.bmp`);writeFileSync(path,fixture.bytes);
    const expected=native(path,p);
    const actual=await page.evaluate(async({bytes,p})=>{const c='/src/codecs.ts',t='/src/terrain.ts';const codec=await import(c),terrain=await import(t);const m=await codec.decodeHeightmap(Uint8Array.from(bytes),p);return {heights:Array.from(m.heights),grid:Array.from(terrain.toGrid(m,p))};},{bytes:Array.from(fixture.bytes),p});
    expect(actual.heights).toEqual(expected.decoded);expect(actual.grid).toEqual(expected.grid);count++;
  }
  writeFileSync(join(output,`browser-native-${info.project.name}.json`),JSON.stringify({browser:info.project.name,matchedCases:count+1,unsupported16bitRejected:true},null,2)+'\n');
});
test('real UI imports, edits by click, undo/redo, exports and retains map on input error',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.locator('#mode').selectOption('clamp');
  await page.locator('#file').setInputFiles(join(output,'fixtures','spike.png'));
  await expect(page.locator('#status')).toContainText('読み込みました');
  const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  expect(before.width).toBe(9);expect(before.heights[40]).toBe(6);
  await page.locator('#radius').fill('1');
  await page.locator('#top').click();
  await page.waitForTimeout(150);
  const canvas=page.locator('#viewport canvas'),box=(await canvas.boundingBox())!;
  await canvas.click({position:{x:box.width/2,y:box.height/2}});
  await expect(page.locator('#status')).toContainText('造成完了');
  const edited=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  expect(edited.heights).not.toEqual(before.heights);expect(edited.undoCount).toBe(1);
  await page.locator('#undo').click();
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(before.heights);
  await page.locator('#redo').click();
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(edited.heights);
  const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;
  const path=join(output,`ui-export-${info.project.name}.bmp`);await download.saveAs(path);
  expect(native(path,edited.profile).grid).toEqual(edited.grid);
  await page.locator('#file').setInputFiles(path);
  await expect(page.locator('#status')).toContainText('読み込みました');
  const reloaded=await page.evaluate(()=>(window as any).__validation.getSnapshot());expect(reloaded.grid).toEqual(edited.grid);
  await page.locator('#file').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('broken')});
  await expect(page.locator('#status')).toHaveClass(/error/);
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).grid).toEqual(reloaded.grid);
  expect(errors).toEqual([]);
  await page.screenshot({path:join(output,`prototype-${info.project.name}.png`),fullPage:true});
});
test('history is capped at twenty atomic strokes and an invalid profile preserves the map',async({page})=>{
  await page.locator('#mode').selectOption('clamp');
  await page.evaluate(()=>{
    const api=(window as any).__validation;
    api.setMap({width:8,height:8,heights:new Float32Array(64)});
    for(let i=0;i<25;i++)api.stroke({x:4,y:4,radius:1,amount:1,tool:'raise'});
  });
  const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  expect(before.undoCount).toBe(20);
  await page.locator('#seaLevel').fill('100');await page.locator('#seaLevel').dispatchEvent('change');
  await expect(page.locator('#status')).toHaveClass(/error/);
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).grid).toEqual(before.grid);
  expect(await page.locator('#seaLevel').inputValue()).toBe('-2');
  for(let i=0;i<20;i++)await page.locator('#undo').click();
  await expect(page.locator('#undo')).toBeDisabled();
  const undone=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  expect(undone.heights[36]).toBe(5);expect(undone.redoCount).toBe(20);
});
test('large header rejects while keeping terrain and 1024 terrain renders',async({page},info)=>{
  const header=Buffer.alloc(13);header.writeUInt32BE(1000000);header.writeUInt32BE(1000000,4);header[8]=8;
  const huge=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header)]);
  await page.locator('#file').setInputFiles({name:'huge.png',mimeType:'image/png',buffer:huge});
  await expect(page.locator('#status')).toHaveClass(/error/);
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).width).toBe(128);
  const metrics=await page.evaluate(async()=>{
    const api=(window as any).__validation;
    const heights=new Float32Array(1024*1024).fill(0);
    const start=performance.now();api.setMap({width:1024,height:1024,heights});const loadMs=performance.now()-start;
    const render=await api.renderSample(12);
    const brushStart=performance.now();api.stroke({x:512,y:512,radius:8,amount:1,tool:'raise'});const brushMs=performance.now()-brushStart;
    const transferStart=performance.now();const buffer=new Float32Array(1024*1024).buffer;
    const url=URL.createObjectURL(new Blob(['onmessage=e=>postMessage(e.data,[e.data])'],{type:'text/javascript'}));
    const worker=new Worker(url);
    const workerBytes=await new Promise<number>((resolve,reject)=>{worker.onmessage=e=>resolve(e.data.byteLength);worker.onerror=reject;worker.postMessage(buffer,[buffer]);});
    const transferMs=performance.now()-transferStart;worker.terminate();URL.revokeObjectURL(url);
    const perf=performance as Performance & {memory?:{usedJSHeapSize:number,totalJSHeapSize:number}};
    return {loadMs,brushMs,...render,...api.getMetrics(),workerBytes,transferMs,usedJSHeapBytes:perf.memory?.usedJSHeapSize??null,userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency};
  });
  expect(metrics.webgl2).toBe(true);expect(metrics.renderedTriangles).toBeGreaterThanOrEqual(2097152);expect(metrics.triangles).toBe(2097152);expect(metrics.workerBytes).toBe(4194304);
  // Performance numbers are observations, not portable acceptance thresholds.
  writeFileSync(join(output,`browser-performance-${info.project.name}.json`),JSON.stringify(metrics,null,2)+'\n');
  await page.screenshot({path:join(output,`prototype-1024-${info.project.name}.png`),fullPage:true});
});

test('raise lower flatten at boundaries export the same grid as native reload',async({page},info)=>{
  let count=0;
  for(const mode of modes)for(const maxSlope of [1,2])for(const tool of ['raise','lower','flatten']) {
    const p={mode,min:-12,max:32,factor:1,maxSlope,seaLevel:-2};
    const result=await page.evaluate(async({p,tool})=>{
      const t='/src/terrain.ts',c='/src/codecs.ts';const terrain=await import(t),codec=await import(c);
      const heights=Float32Array.from({length:81},(_,i)=>i===4+4*9?6:-4);
      const map={width:9,height:9,heights};
      const edited=terrain.applyBrush(map,p,{x:tool==='flatten'?0:4,y:tool==='flatten'?0:4,radius:2,amount:2,tool,target:1});
      return {grid:Array.from(terrain.toGrid(edited.map,p)),bytes:Array.from(codec.exportBmp(edited.map,p)),changed:edited.changed};
    },{p,tool});
    expect(result.changed).toBeGreaterThan(0);
    const path=join(output,`brush-${info.project.name}-${mode}-${maxSlope}-${tool}.bmp`);writeFileSync(path,Uint8Array.from(result.bytes as number[]));
    expect(native(path,p).grid,`${mode}/${maxSlope}/${tool}`).toEqual(result.grid);count++;
  }
  writeFileSync(join(output,`browser-brush-${info.project.name}.json`),JSON.stringify({browser:info.project.name,matchedCases:count},null,2)+'\n');
});

test('unrepresentable heights are reported before and during BMP export',async({page})=>{
  await page.locator('#mode').selectOption('clamp');
  await page.evaluate(()=>(window as any).__validation.setMap({width:8,height:8,heights:new Float32Array(64).fill(20)}));
  await page.locator('#mode').selectOption('legacy-small');
  await expect(page.locator('#quantization')).toHaveClass(/warning/);
  await expect(page.locator('#quantization')).toContainText('到達範囲外 64');
  await expect(page.locator('#quantization')).toContainText('到達標高 -12〜9');
  const pending=page.waitForEvent('download');await page.locator('#export').click();await pending;
  await expect(page.locator('#status')).toContainText('到達範囲外 64');
  const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());expect(before.heights[0]).toBe(20);
  await page.evaluate(()=>(window as any).__validation.stroke({x:4,y:4,radius:1,amount:1,tool:'raise'}));
  await page.locator('#undo').click();
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(before.heights);
});
