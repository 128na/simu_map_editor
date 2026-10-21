import {test,expect} from '@playwright/test';

const snapshot=(page:any)=>page.evaluate(()=>(window as any).__validation.getSnapshot());
async function expectFullGrid(page:any){
 const result=await page.evaluate(async()=>{
  const path='/src/terrain.ts',terrain=await import(path),state=(window as any).__validation.getSnapshot();
  return {actual:state.grid,expected:Array.from(terrain.toGrid({width:state.width,height:state.height,heights:Float32Array.from(state.heights)},state.profile))};
 });
 expect(result.actual).toEqual(result.expected);
}
test.beforeEach(async({page})=>{
 page.on('dialog',dialog=>void dialog.accept());await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
});

test('stored undo redo match full conversion across coasts, outer edges and compatibility profiles',async({page})=>{
 for(const mode of ['linear','clamp','legacy-small','legacy-large']){
  await page.locator('#mode').selectOption(mode);
  await page.evaluate(()=>{
   const api=(window as any).__validation,width=65,height=49;
   const heights=Float32Array.from({length:width*height},(_,i)=>Math.floor((i%width)/4)-8);
   api.setMap({width,height,heights});
  });
  const original=await snapshot(page);
  for(const brush of [{x:0,y:0,radius:5,amount:3,tool:'raise'},{x:64,y:48,radius:8,amount:4,tool:'lower'},{x:30,y:24,radius:12,amount:4,tool:'raise'}]){
   await page.evaluate(async brush=>{const api=(window as any).__validation;api.stroke(brush);await api.waitHistory();},brush);
  }
  const edited=await snapshot(page);await expectFullGrid(page);
  for(let n=0;n<3;n++){await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('元に戻しました');await expectFullGrid(page);}
  expect((await snapshot(page)).heights).toEqual(original.heights);expect((await snapshot(page)).grid).toEqual(original.grid);
  for(let n=0;n<3;n++){await page.locator('#redo').click();await expect(page.locator('#status')).toContainText('やり直しました');await expectFullGrid(page);}
  expect((await snapshot(page)).heights).toEqual(edited.heights);expect((await snapshot(page)).grid).toEqual(edited.grid);
 }
});

test('undo to unnormalized source preserves native conversion and renderer failure rolls back the grid',async({page})=>{
 await page.evaluate(async()=>{
  const api=(window as any).__validation;api.setMap({width:65,height:49,heights:Float32Array.from({length:3185},(_,i)=>i===0?3.25:0)});
  api.stroke({x:8,y:6,radius:3,amount:1,tool:'raise'});await api.waitHistory();
 });
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('元に戻しました');await expectFullGrid(page);
 expect(await page.evaluate(()=>(window as any).__validation.getTimings().historyLocal)).toBe(0);
 await page.locator('#redo').click();await expect(page.locator('#status')).toContainText('やり直しました');await expectFullGrid(page);
 expect(await page.evaluate(()=>(window as any).__validation.getTimings().historyLocal)).toBe(0);
 await page.evaluate(async()=>{const api=(window as any).__validation;api.stroke({x:15,y:11,radius:2,amount:1,tool:'raise'});await api.waitHistory();});
 const before=await snapshot(page);
 await page.evaluate(async()=>{
  const path='/src/terrain-surface.ts',{TerrainSurface}=await import(path),update=TerrainSurface.prototype.update;
  TerrainSurface.prototype.update=function(...args:any[]){if((window as any).__failHistoryRender)throw new Error('History renderer allocation failure');return update.apply(this,args);};
  (window as any).__failHistoryRender=true;
 });
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('History renderer allocation failure');expect(await snapshot(page)).toEqual(before);
 await page.evaluate(()=>(window as any).__failHistoryRender=false);
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('元に戻しました');await expectFullGrid(page);
 expect(await page.evaluate(()=>(window as any).__validation.getTimings().historyLocal)).toBe(1);
});


test('dense history restores keep the full conversion fallback',async({page})=>{
 await page.evaluate(async()=>{const api=(window as any).__validation;api.setMap({width:20,height:20,heights:new Float32Array(400)});api.stroke({x:10,y:10,radius:40,amount:1,tool:'raise'});await api.waitHistory();});
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('元に戻しました');await expectFullGrid(page);
 expect(await page.evaluate(()=>(window as any).__validation.getTimings().historyLocal)).toBe(0);
 expect((await snapshot(page)).heights).toEqual(new Array(400).fill(0));
});
