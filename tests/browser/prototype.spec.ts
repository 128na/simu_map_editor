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
  page.on('dialog',dialog=>void dialog.accept());
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
        const normalized=terrain.normalizeImport(map,profile).map;
        const exported=codec.exportBmp(normalized,profile),again=await codec.decodeHeightmap(exported,profile);
        return {heights:Array.from(map.heights),grid:Array.from(terrain.toGrid(map,profile)),again:Array.from(terrain.toGrid(again,profile)),normalizedGrid:Array.from(terrain.toGrid(normalized,profile)),normalizedHeights:Array.from(normalized.heights),normalizedAgain:terrain.normalizeImport(again,profile).changed};
      },{bytes:Array.from(bytes),profile});
      expect(actual.heights,fixture.name).toEqual(expected.decoded);
      expect(actual.grid,`${fixture.name}/${mode}/${factor}/${maxSlope}`).toEqual(expected.grid);
      expect(actual.again,fixture.name+' normalized roundtrip').toEqual(actual.normalizedGrid);
      expect(actual.normalizedAgain).toBe(0);
      for(let y=0;y<expected.height;y++)for(let x=0;x<expected.width;x++)expect(actual.normalizedHeights[y*expected.width+x]).toBe(expected.grid[y*(expected.width+1)+x]-1);count++;
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
  await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('造成を元に戻しました');
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(before.heights);
  await page.locator('#redo').click();await expect(page.locator('#status')).toContainText('造成をやり直しました');
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
test('history stores more than twenty atomic delta strokes and an invalid profile preserves the map',async({page})=>{
  await page.locator('#mode').selectOption('clamp');
  await page.evaluate(()=>{
    const api=(window as any).__validation;
    api.setMap({width:8,height:8,heights:new Float32Array(64)});
    for(let i=0;i<25;i++)api.stroke({x:4,y:4,radius:1,amount:1,tool:'raise'});
  });
  const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  expect(before.undoCount).toBe(25);
  await page.locator('#seaLevel').fill('100');await page.locator('#seaLevel').dispatchEvent('change');
  await expect(page.locator('#status')).toHaveClass(/error/);
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).grid).toEqual(before.grid);
  expect(await page.locator('#seaLevel').inputValue()).toBe('-2');
  for(let i=0;i<25;i++){await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('造成を元に戻しました');await expect.poll(async()=> (await page.evaluate(()=>(window as any).__validation.getSnapshot())).undoCount).toBe(24-i);}
  await expect(page.locator('#undo')).toBeDisabled();
  const undone=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  expect(undone.heights[36]).toBe(0);expect(undone.redoCount).toBe(25);
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
  await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('造成を元に戻しました');
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(before.heights);
});

test('drag holds its first height across sparse moves and is a single undo operation',async({page})=>{
  await page.locator('#mode').selectOption('clamp');
  await page.evaluate(()=>(window as any).__validation.setMap({width:32,height:16,heights:new Float32Array(512)}));
  await page.locator('#radius').fill('1');await page.locator('#amount').fill('2');await page.locator('#top').click();
  await page.waitForTimeout(150);
  const [start,end]=await page.evaluate(()=>[4,27].map(x=>(window as any).__validation.projectSample(x,8)));
  await page.mouse.move(start.x,start.y);await page.mouse.down();
  await page.mouse.move(end.x,end.y,{steps:3});await page.mouse.move(start.x,start.y,{steps:2});await page.mouse.up();
  const raised=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  for(let x=4;x<=27;x++)expect(raised.heights[x+8*32],`column ${x}`).toBe(2);
  expect(raised.undoCount).toBe(1);await expect(page.locator('#dragHeight')).toHaveText('3');
  await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('造成を元に戻しました');expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(new Array(512).fill(0));
  await page.locator('#redo').click();await expect(page.locator('#status')).toContainText('造成をやり直しました');expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(raised.heights);
  // Cancelling rolls back the whole in-progress drag without making another history entry.
  const point=await page.evaluate(()=>(window as any).__validation.projectSample(15,8));
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.keyboard.press('Escape');await page.mouse.up();
  const cancelled=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  expect(cancelled.heights).toEqual(raised.heights);expect(cancelled.undoCount).toBe(1);
});

test('flatten dragging samples the start height and right-drag rotates without editing',async({page})=>{
  await page.locator('#mode').selectOption('clamp');
  await page.evaluate(()=>(window as any).__validation.setMap({width:32,height:16,heights:Float32Array.from({length:512},(_,i)=>Math.floor((i%32)/4))}));
  await page.locator('#tool').selectOption('flatten');await page.locator('#radius').fill('1');await page.locator('#top').click();await page.waitForTimeout(150);
  const [start,end]=await page.evaluate(()=>[5,27].map(x=>(window as any).__validation.projectSample(x,8)));
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:3});await page.mouse.up();
  const flattened=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  for(let x=5;x<=27;x++)expect(flattened.heights[x+8*32],`column ${x}`).toBe(1);
  expect(flattened.undoCount).toBe(1);
  await page.mouse.move(start.x,start.y);await page.mouse.down({button:'right'});await page.mouse.move(start.x+100,start.y+60,{steps:5});await page.mouse.up({button:'right'});
  const rotated=await page.evaluate(()=>(window as any).__validation.getSnapshot());expect(rotated.heights).toEqual(flattened.heights);expect(rotated.undoCount).toBe(1);
});

test('water avoids sea-level ground and stays a single clipped surface while rotating',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.evaluate(()=>(window as any).__validation.setMap({width:32,height:32,heights:new Float32Array(1024).fill(-3)}));
  expect((await page.evaluate(()=>(window as any).__validation.getMetrics())).waterTriangles).toBe(0);
  await page.evaluate(()=>(window as any).__validation.setMap({width:32,height:32,heights:Float32Array.from({length:1024},(_,i)=>i%32<16?-5:-2)}));
  const before=await page.evaluate(()=>(window as any).__validation.getMetrics());expect(before.waterTriangles).toBeGreaterThan(0);
  const canvas=page.locator('#viewport canvas'),box=(await canvas.boundingBox())!;
  for(let turn=0;turn<3;turn++){
    await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down({button:'right'});await page.mouse.move(box.x+box.width*.7,box.y+box.height*.55,{steps:8});await page.mouse.up({button:'right'});
    await page.screenshot({path:join(output,`water-rotation-${info.project.name}-${turn}.png`)});
  }
  expect((await page.evaluate(()=>(window as any).__validation.getMetrics())).waterTriangles).toBe(before.waterTriangles);expect(errors).toEqual([]);
});

test('same-frame turns and reversals retain every drag segment before pointerup',async({page})=>{
  await page.locator('#mode').selectOption('clamp');
  await page.evaluate(()=>(window as any).__validation.setMap({width:32,height:32,heights:new Float32Array(1024)}));
  await page.locator('#radius').fill('1');await page.locator('#top').click();await page.waitForTimeout(100);
  const points=await page.evaluate(()=>[[4,4],[27,4],[27,27]].map(([x,y])=>(window as any).__validation.projectSample(x,y)));
  await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();
  await page.evaluate(points=>{
    const canvas=document.querySelector('canvas')!;
    for(const p of [points[1],points[2],points[0]])canvas.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,pointerType:'mouse',buttons:1,clientX:p.x,clientY:p.y,bubbles:true}));
    canvas.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,pointerType:'mouse',button:0,buttons:0,clientX:points[0].x,clientY:points[0].y,bubbles:true}));
  },points);
  await page.mouse.up();
  const result=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  for(let x=4;x<=27;x++)expect(result.heights[x+4*32]).toBe(1);
  for(let y=4;y<=27;y++)expect(result.heights[27+y*32]).toBe(1);
  expect(result.undoCount).toBe(1);
});

test('excessively intricate water refuses allocation without replacing the current terrain',async({page})=>{
  await page.locator('#mode').selectOption('clamp');await page.locator('#maxSlope').selectOption('2');await page.locator('#seaLevel').fill('0');await page.locator('#seaLevel').dispatchEvent('change');
  const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  const error=await page.evaluate(()=>{
    try{(window as any).__validation.setMap({width:512,height:512,heights:Float32Array.from({length:512*512},(_,i)=>(Math.floor(i/512)+i%512)%2?-2:0)});return '';}
    catch(error){return String(error);}
  });
  expect(error).toContain('16');
  const after=await page.evaluate(()=>(window as any).__validation.getSnapshot());expect(after.heights).toEqual(before.heights);expect(after.grid).toEqual(before.grid);expect(after.width).toBe(before.width);
});


test('new map dimensions create a flat editable exportable terrain and invalid sizes preserve it',async({page},info)=>{
  const snapshot=()=>page.evaluate(()=>(window as any).__validation.getSnapshot());
  await page.evaluate(()=>(window as any).__validation.stroke({x:64,y:64,radius:2,amount:1,tool:'raise'}));
  await page.locator('#newWidth').fill('37');await page.locator('#newHeight').fill('19');
  await page.locator('#create').click();
  await expect(page.locator('#status')).toContainText('37 × 19');
  const fresh=await snapshot();
  expect([fresh.width,fresh.height,fresh.heights.length,fresh.grid.length]).toEqual([37,19,37*19,38*20]);
  expect(fresh.heights.every((h:number)=>h===0)).toBe(true);
  expect(fresh.grid.every((h:number)=>h===1)).toBe(true);
  expect([fresh.undoCount,fresh.redoCount]).toEqual([0,0]);
  await expect(page.locator('#undo')).toBeDisabled();
  for(const [w,h] of [['0','19'],['2.5','19'],['4097','1'],['4096','4097'],['','19']]){
    await page.locator('#newWidth').fill(w);await page.locator('#newHeight').fill(h);await page.locator('#create').click();
    await expect(page.locator('#status')).toHaveClass(/error/);expect(await snapshot()).toEqual(fresh);
  }
  await page.locator('#top').click();await page.waitForTimeout(150);
  const at=await page.evaluate(()=>(window as any).__validation.projectSample(18,9));
  await page.mouse.click(at.x,at.y);await expect(page.locator('#status')).toContainText('造成完了');
  const edited=await snapshot();expect(edited.undoCount).toBe(1);expect(edited.heights).not.toEqual(fresh.heights);
  const pending=page.waitForEvent('download');await page.locator('#export').click();const download=await pending;
  const path=join(output,`new-map-${info.project.name}.bmp`);await download.saveAs(path);
  expect(native(path,edited.profile).grid).toEqual(edited.grid);
  await page.locator('#newWidth').fill('1');await page.locator('#newHeight').fill('1');await page.locator('#create').click();
  const tiny=await snapshot();expect([tiny.width,tiny.height,tiny.grid.length,tiny.undoCount]).toEqual([1,1,4,0]);
  await page.screenshot({path:join(output,`new-map-ui-${info.project.name}.png`),fullPage:true});
});


test('4096-square flat map can be created and rendered at the expanded limit',async({page},info)=>{
  test.skip(!process.env.VALIDATE_LARGE_MAP,'Explicit large-memory validation');
  test.setTimeout(180000);
  await page.locator('#newWidth').fill('4096');await page.locator('#newHeight').fill('4096');
  const started=Date.now();await page.locator('#create').click({timeout:150000});
  await expect(page.locator('#status')).toContainText('4096 × 4096',{timeout:150000});
  const result=await page.evaluate(async()=>{
    const api=(window as any).__validation;
    return {metrics:api.getMetrics(),render:await api.renderSample(3)};
  });
  expect(result.metrics.triangles).toBe(4096*4096*2);
  expect(result.metrics.renderedTriangles).toBeGreaterThanOrEqual(4096*4096*2);
  writeFileSync(join(output,`large-map-${info.project.name}.json`),JSON.stringify({elapsedMs:Date.now()-started,...result},null,2));
  await page.screenshot({path:join(output,`large-map-${info.project.name}.png`)});
});

test('import correction warning can be canceled and normalized source exports without further correction',async({page},info)=>{
  await page.locator('#mode').selectOption('clamp');
  await page.evaluate(()=>{const a=(window as any).__validation;a.setMap({width:4,height:3,heights:new Float32Array(12)});a.stroke({x:1,y:1,radius:1,amount:1,tool:'raise'});});
  const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  page.removeAllListeners('dialog');
  let message='';page.once('dialog',async dialog=>{message=dialog.message();await dialog.dismiss();});
  await page.locator('#file').setInputFiles(join(output,'fixtures','spike.png'));
  await expect(page.locator('#status')).toContainText('取り消しました');
  expect(message).toContain('斜面補正');expect(message).toContain('補正済み');
  expect(await page.evaluate(()=>(window as any).__validation.getSnapshot())).toEqual(before);
  expect(await page.evaluate(()=>(window as any).__validation.getHistoryState().dirty)).toBe(true);
  page.on('dialog',dialog=>void dialog.accept());
  await page.locator('#file').setInputFiles(join(output,'fixtures','spike.png'));
  await expect(page.locator('#status')).toContainText('補正済み');
  const corrected=await page.evaluate(()=>(window as any).__validation.getSnapshot());
  expect(corrected.heights.filter((v:number)=>v>0).length).toBeGreaterThan(1);
  expect(corrected.undoCount).toBe(0);
  expect(await page.evaluate(()=>(window as any).__validation.getHistoryState().dirty)).toBe(true);
  const pending=page.waitForEvent('download');await page.locator('#export').click();
  const path=join(output,`normalized-${info.project.name}.bmp`);await(await pending).saveAs(path);
  expect(native(path,corrected.profile).grid).toEqual(corrected.grid);
  await page.locator('#file').setInputFiles(path);
  await expect(page.locator('#status')).toContainText('補正はありません');
  expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).grid).toEqual(corrected.grid);
  expect(await page.evaluate(()=>(window as any).__validation.getHistoryState().dirty)).toBe(false);
});
