import {test,expect} from '@playwright/test';
const snapshot=(page:any)=>page.evaluate(()=>(window as any).__validation.getSnapshot());
test.beforeEach(async({page})=>{page.on('dialog',d=>void d.accept());await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);});
test('sea settings preserve history and range changes discard incompatible past entries',async({page})=>{
 await expect(page.locator('#compatibilityTarget')).toContainText('af90444e4');
 await page.locator('#profilePreset').selectOption('standard-clamp');await expect(page.locator('#mode')).toHaveValue('clamp');
 await page.evaluate(()=>{const a=(window as any).__validation;a.setMap({width:16,height:16,heights:new Float32Array(256)});a.stroke({x:8,y:8,radius:1,amount:1,tool:'raise'});});
 const pending=page.waitForEvent('download');await page.locator('#export').click();await pending;
 const before=await snapshot(page);
 await page.locator('#seaLevel').fill('-3');await page.locator('#seaLevel').dispatchEvent('change');
 expect((await snapshot(page)).undoCount).toBe(1);expect((await snapshot(page)).heights).toEqual(before.heights);
 expect(await page.evaluate(()=>(window as any).__validation.getHistoryState().dirty)).toBe(false);
 await page.locator('#min').fill('-40');await page.locator('#min').dispatchEvent('change');
 expect((await snapshot(page)).undoCount).toBe(0);expect((await snapshot(page)).profile.min).toBe(-40);
 expect(await page.evaluate(()=>(window as any).__validation.getHistoryState().dirty)).toBe(true);
 await page.locator('#min').fill('-128');await page.locator('#min').dispatchEvent('change');await expect(page.locator('#status')).toHaveClass(/error/);
 await expect(page.locator('#min')).toHaveValue('-40');expect((await snapshot(page)).undoCount).toBe(0);
});
test('correction after changing conversion is confirmed and cancellation retains the original',async({page})=>{
 await page.locator('#mode').selectOption('clamp');
 await page.evaluate(()=>{const a=(window as any).__validation;a.setMap({width:8,height:8,heights:new Float32Array(64).fill(20)});a.stroke({x:4,y:4,radius:1,amount:1,tool:'raise'});});
 const before=await snapshot(page);page.removeAllListeners('dialog');let message='';page.once('dialog',async d=>{message=d.message();await d.dismiss();});
 await page.locator('#mode').selectOption('legacy-small');await expect(page.locator('#mode')).toHaveValue('clamp');expect(message).toContain('64画素');expect(await snapshot(page)).toEqual(before);
 page.on('dialog',d=>void d.accept());await page.locator('#mode').selectOption('legacy-small');
 const corrected=await snapshot(page);expect(corrected.heights).toEqual(new Array(64).fill(9));expect(corrected.undoCount).toBe(0);
 expect(await page.evaluate(()=>(window as any).__validation.getHistoryState().dirty)).toBe(true);
});

test('conversion change discards history even when only a past state is unrepresentable',async({page})=>{
 await page.locator('#mode').selectOption('clamp');await page.evaluate(()=>{const a=(window as any).__validation;a.setMap({width:4,height:4,heights:new Float32Array(16).fill(20)});a.stroke({x:1,y:1,radius:20,amount:1,tool:'flatten',target:0});});
 expect((await snapshot(page)).undoCount).toBe(1);await page.locator('#mode').selectOption('legacy-small');
 expect((await snapshot(page)).heights).toEqual(new Array(16).fill(0));expect((await snapshot(page)).undoCount).toBe(0);await expect(page.locator('#undo')).toBeDisabled();
});


test('sea level changes apply without dialogs and preserve source and history',async({page})=>{
 await page.evaluate(()=>(window as any).__validation.stroke({x:16,y:16,radius:2,amount:3,tool:'raise'}));
 const before=await snapshot(page);let dialogs=0;page.removeAllListeners('dialog');page.on('dialog',async d=>{dialogs++;await d.dismiss();});
 for(const level of [-3,0,2]){await page.locator('#seaLevel').fill(String(level));await page.locator('#seaLevel').dispatchEvent('change');expect((await snapshot(page)).profile.seaLevel).toBe(level);}
 const after=await snapshot(page);expect(dialogs).toBe(0);expect(after.heights).toEqual(before.heights);expect(after.undoCount).toBe(before.undoCount);
});
