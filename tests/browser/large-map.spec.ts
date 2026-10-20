import {test,expect} from '@playwright/test';
import {chunk} from '../fixtures.ts';
import {writeFileSync} from 'node:fs';
test.beforeEach(async({page})=>{await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);});
test('large map warnings can cancel before replacement or PNG decompression',async({page})=>{
 const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());
 let message='';page.once('dialog',async d=>{message=d.message();await d.dismiss();});
 await page.locator('#newWidth').fill('4097');await page.locator('#newHeight').fill('2');await page.locator('#create').click();
 expect(message).toContain('標準の4096四方');expect(await page.evaluate(()=>(window as any).__validation.getSnapshot())).toEqual(before);
 const header=Buffer.alloc(13);header.writeUInt32BE(8192);header.writeUInt32BE(8192,4);header[8]=8;
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header)]);
 page.once('dialog',async d=>{message=d.message();await d.dismiss();});
 await page.locator('#file').setInputFiles({name:'large.png',mimeType:'image/png',buffer:bytes});await expect(page.locator('#status')).toContainText('取り消しました');
 expect(message).toContain('8,192');expect(await page.evaluate(()=>(window as any).__validation.getSnapshot())).toEqual(before);
 page.on('dialog',d=>void d.accept());await page.locator('#create').click();await expect(page.locator('#status')).toContainText('4097 × 2');
 expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).width).toBe(4097);
});

test('8192 square remains editable and exportable with bounded terrain geometry',async({page},info)=>{
 test.skip(!process.env.VALIDATE_LARGE_MAP,'Explicit large-memory validation');test.setTimeout(360000);
 page.on('dialog',d=>void d.accept());await page.locator('#newWidth').fill('8192');await page.locator('#newHeight').fill('8192');
 const start=Date.now();await page.locator('#create').click({timeout:180000});await expect(page.locator('#status')).toContainText('8192 × 8192',{timeout:180000});
 const metrics=await page.evaluate(()=>(window as any).__validation.getMetrics());expect(metrics.displayStride).toBe(8);expect(metrics.geometryBytes).toBeLessThan(128*1048576);
 const edit=Date.now();await page.evaluate(()=>(window as any).__validation.stroke({x:4096,y:4096,radius:8,amount:1,tool:'raise'}));const editMs=Date.now()-edit;
 expect(await page.evaluate(()=>(window as any).__validation.getHistoryState().undoCount)).toBe(1);
 const point=await page.evaluate(()=>(window as any).__validation.projectSample(4096,4096));await page.mouse.move(point.x,point.y);
 await expect.poll(async()=>(await page.evaluate(()=>(window as any).__validation.getMetrics())).displayTriangles).toBeGreaterThan(metrics.displayTriangles);
 const detailMetrics=await page.evaluate(()=>(window as any).__validation.getMetrics());expect(detailMetrics.geometryBytes).toBeLessThan(128*1048576);
 const undo=Date.now();await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('造成を元に戻しました',{timeout:120000});const undoMs=Date.now()-undo;
 const pending=page.waitForEvent('download');await page.locator('#exportPng').click();const download=await pending;expect(download.suggestedFilename()).toContain('.png');
 writeFileSync(`.validation/large-8192-${info.project.name}.json`,JSON.stringify({createMs:edit-start,editMs,undoMs,totalMs:Date.now()-start,metrics,detailMetrics},null,2));
});
