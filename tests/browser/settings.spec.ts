import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{page.on('dialog',d=>void d.accept());await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);});
test('resource settings persist and enforce map/file/brush/water limits without losing edits',async({page})=>{
 await page.evaluate(()=>(window as any).__validation.stroke({x:16,y:16,radius:2,amount:1,tool:'raise'}));
 const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());await page.locator('#resourceSettings > summary').click();
 await page.locator('#maxTiles').fill('32768');await page.locator('#maxFileMiB').fill('1');await page.locator('#maxBrushRadius').fill('80');await page.locator('#waterMiB').selectOption('32');await page.locator('#displayCells').selectOption('2097152');await page.locator('#applySettings').click();
 await expect(page.locator('#status')).toContainText('適用しました');expect(await page.evaluate(()=>(window as any).__validation.getSnapshot())).toEqual(before);await expect(page.locator('#radius')).toHaveAttribute('max','80');
 expect((await page.evaluate(()=>(window as any).__validation.getMetrics())).waterBudgetBytes).toBe(32*1048576);
 await page.locator('#newWidth').fill('256');await page.locator('#newHeight').fill('256');await page.locator('#create').click();await expect(page.locator('#status')).toContainText('32,768');
 await page.locator('#file').setInputFiles({name:'oversize.bmp',mimeType:'image/bmp',buffer:Buffer.alloc(1048577)});await expect(page.locator('#status')).toContainText('1 MiB');
 expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(before.heights);
 await page.reload();await page.waitForFunction(()=>!!(window as any).__validation);await expect.poll(async()=>(await page.evaluate(()=>(window as any).__validation.getMetrics())).viewAware).toBe(true);expect((await page.evaluate(()=>(window as any).__validation.getEditorSettings())).maxBrushRadius).toBe(80);expect((await page.evaluate(()=>(window as any).__validation.getMetrics())).displayCellBudget).toBe(2097152);
});
test('wider smoothing relaxes a finite slope and undo restores it',async({page})=>{
 await page.locator('#mode').selectOption('clamp');await page.evaluate(()=>{const w=65,h=33,heights=Float32Array.from({length:w*h},(_,i)=>Math.max(0,Math.min(4,i%w-30)));(window as any).__validation.setMap({width:w,height:h,heights});});
 const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());await page.locator('#tool').selectOption('smooth');await expect(page.locator('#smoothingControls')).toBeVisible();await page.locator('#smoothingRadius').fill('8');await page.locator('#smoothingRadius').dispatchEvent('change');await page.locator('#radius').fill('16');await page.locator('#top').click();
 const at=await page.evaluate(()=>(window as any).__validation.projectSample(32,16));await page.mouse.click(at.x,at.y);
 const after=await page.evaluate(()=>(window as any).__validation.getSnapshot());expect(after.heights[16*65+28]).toBeGreaterThan(before.heights[16*65+28]);expect(after.heights[16*65+36]).toBeLessThan(before.heights[16*65+36]);expect(after.undoCount).toBe(1);
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('元に戻しました');expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(before.heights);
});


test('slope mode reduces a straight local gradient and preserves a single undo',async({page})=>{
 await page.locator('#mode').selectOption('clamp');await page.evaluate(()=>{const w=65,heights=Float32Array.from({length:w*w},(_,i)=>Math.max(-10,Math.min(10,i%w-32)));(window as any).__validation.setMap({width:w,height:w,heights});});
 const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());await page.locator('#tool').selectOption('smooth');await page.locator('#smoothingMode').selectOption('slope');await page.locator('#smoothingRadius').fill('1');await page.locator('#smoothingRadius').dispatchEvent('change');await page.locator('#radius').fill('16');await page.locator('#top').click();
 const at=await page.evaluate(()=>(window as any).__validation.projectSample(32,32));await page.mouse.click(at.x,at.y);
 const after=await page.evaluate(()=>(window as any).__validation.getSnapshot());expect(after.heights[32*65+34]-after.heights[32*65+30]).toBeLessThan(4);expect(after.undoCount).toBe(1);expect(after.heights[32*65]).toBe(-10);expect(after.heights[32*65+64]).toBe(10);
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('元に戻しました');expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights).toEqual(before.heights);
 await page.reload();await page.waitForFunction(()=>!!(window as any).__validation);expect((await page.evaluate(()=>(window as any).__validation.getEditorSettings())).smoothingMode).toBe('slope');
});
