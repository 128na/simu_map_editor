import {test,expect,type Page} from '@playwright/test';
const state=(page:Page)=>page.evaluate(()=>(window as any).__validation.getHistoryState());
const snapshot=(page:Page)=>page.evaluate(()=>(window as any).__validation.getSnapshot());
async function stroke(page:Page,x=8){return page.evaluate(x=>{try{(window as any).__validation.stroke({x,y:8,radius:1,amount:1,tool:'raise'});return '';}catch(error){return String(error);}},x);}
async function settled(page:Page){await page.evaluate(()=>(window as any).__validation.waitHistory());}
test.beforeEach(async({page})=>{
  page.on('dialog',dialog=>dialog.accept());
  await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation?.configureHistory);
  await page.locator('#mode').selectOption('clamp');
  await page.evaluate(()=>{const api=(window as any).__validation;api.setMap({width:32,height:32,heights:new Float32Array(1024)});api.configureHistory({ramBudgetBytes:1024*1024,diskBudgetBytes:1024*1024,maxEntries:100});});
});

test('history registration does not wait for storage and pending history can undo and branch',async({page})=>{
  await page.evaluate(()=>(window as any).__validation.setHistoryFault({putDelayMs:1500}));
  expect(await stroke(page)).toBe('');
  const pending=await state(page);expect(pending.undoCount).toBe(1);expect(pending.queuedBytes).toBeGreaterThan(0);expect(pending.storedBytes).toBe(0);
  await page.locator('#undo').click();await expect.poll(async()=>(await state(page)).undoCount).toBe(0);
  expect((await snapshot(page)).heights).toEqual(new Array(1024).fill(0));
  expect(await stroke(page,22)).toBe('');expect((await state(page)).redoCount).toBe(0);
  await page.evaluate(()=>(window as any).__validation.setHistoryFault({}));await settled(page);
  expect((await state(page)).undoCount).toBe(1);expect((await state(page)).redoCount).toBe(0);
  await page.locator('#undo').click();await expect.poll(async()=>(await state(page)).undoCount).toBe(0);
  expect((await snapshot(page)).heights).toEqual(new Array(1024).fill(0));
});

test('disk undo locks editing while loading and failed reads preserve map and cursor',async({page})=>{
  await stroke(page);await settled(page);const edited=await snapshot(page);
  expect((await state(page)).queuedBytes).toBe(0);
  await page.evaluate(()=>(window as any).__validation.setHistoryFault({readDelayMs:1000,failRead:true}));
  await page.locator('#undo').click();await expect.poll(async()=>(await state(page)).reading).toBe(true);
  await expect(page.locator('#redo')).toBeDisabled();await expect(page.locator('#create')).toBeDisabled();
  expect(await stroke(page,22)).not.toBe('');
  await expect.poll(async()=>(await state(page)).reading).toBe(false);
  expect((await snapshot(page)).heights).toEqual(edited.heights);expect((await state(page)).undoCount).toBe(1);
  await page.evaluate(()=>(window as any).__validation.setHistoryFault({}));await page.locator('#undo').click();
  await expect.poll(async()=>(await state(page)).undoCount).toBe(0);expect((await snapshot(page)).heights).toEqual(new Array(1024).fill(0));
});

test('map replacement ignores old pending quota failure',async({page})=>{
  await page.evaluate(()=>(window as any).__validation.setHistoryFault({putDelayMs:300,failPut:true}));await stroke(page);
  await page.evaluate(()=>{const api=(window as any).__validation;api.setMap({width:16,height:16,heights:new Float32Array(256).fill(3)});});
  await settled(page);expect((await state(page)).failed).toBe(false);expect((await state(page)).undoCount).toBe(0);
  expect((await snapshot(page)).heights).toEqual(new Array(256).fill(3));
  await page.evaluate(()=>(window as any).__validation.setHistoryFault({}));expect(await stroke(page)).toBe('');await settled(page);expect((await state(page)).undoCount).toBe(1);
});

test('failed history saves retain undo, block editing, allow export and explicit memory fallback',async({page})=>{
  await page.evaluate(()=>(window as any).__validation.setHistoryFault({failPut:true}));await stroke(page);await settled(page);
  const before=await snapshot(page),failed=await state(page);expect(failed.failed).toBe(true);expect(failed.queuedBytes).toBeGreaterThan(0);
  expect(await stroke(page,22)).not.toBe('');expect((await snapshot(page)).heights).toEqual(before.heights);
  await expect(page.locator('#export')).toBeEnabled();
  const download=page.waitForEvent('download');await page.locator('#export').click();expect((await download).suggestedFilename()).toMatch(/\.bmp$/);
  await page.locator('#undo').click();await expect.poll(async()=>(await state(page)).undoCount).toBe(0);expect((await snapshot(page)).heights).toEqual(new Array(1024).fill(0));
  await page.locator('#redo').click();await expect.poll(async()=>(await state(page)).undoCount).toBe(1);expect((await snapshot(page)).heights).toEqual(before.heights);
  await page.locator('#historyMemory').click();expect((await state(page)).failed).toBe(false);expect((await state(page)).undoCount).toBe(0);expect((await snapshot(page)).heights).toEqual(before.heights);
  expect(await stroke(page,22)).toBe('');expect((await state(page)).undoCount).toBe(1);
  await page.locator('#undo').click();await expect.poll(async()=>(await state(page)).undoCount).toBe(0);expect((await snapshot(page)).heights).toEqual(before.heights);
});

test('history queue budget rejects edits without changing current terrain or history',async({page})=>{
  await page.evaluate(()=>{const api=(window as any).__validation;api.configureHistory({ramBudgetBytes:1,diskBudgetBytes:1024*1024,maxEntries:100});});
  const before=await snapshot(page);expect(await stroke(page)).not.toBe('');
  expect((await snapshot(page)).heights).toEqual(before.heights);expect((await state(page)).undoCount).toBe(0);expect((await state(page)).queuedBytes).toBe(0);
});



test('temporary queue pressure rolls back the next edit and resumes after storage drains',async({page})=>{
  const result=await page.evaluate(()=>{
    const api=(window as any).__validation;api.configureHistory({ramBudgetBytes:100,diskBudgetBytes:1024*1024,maxEntries:100});api.setHistoryFault({putDelayMs:500});
    api.stroke({x:8,y:8,radius:1,amount:1,tool:'raise'});const before=api.getSnapshot();let error='';
    try{api.stroke({x:22,y:8,radius:1,amount:1,tool:'raise'});}catch(e){error=String(e);}
    return {before,after:api.getSnapshot(),state:api.getHistoryState(),error};
  });
  expect(result.error).not.toBe('');expect(result.state.undoCount).toBe(1);expect(result.state.paused).toBe(true);expect(result.state.queuedBytes).toBeGreaterThan(0);expect(result.after.heights).toEqual(result.before.heights);
  await settled(page);await expect.poll(async()=>(await state(page)).paused).toBe(false);expect((await state(page)).queuedBytes).toBe(0);
  await page.evaluate(()=>(window as any).__validation.setHistoryFault({}));expect(await stroke(page,22)).toBe('');expect((await state(page)).undoCount).toBe(2);
});

test('canceling new map creation preserves terrain, history and unsaved changes',async({page})=>{
  await stroke(page);const before=await snapshot(page),historyBefore=await state(page);expect(historyBefore.dirty).toBe(true);
  await page.locator('#newWidth').fill('16');await page.locator('#newHeight').fill('16');
  page.removeAllListeners('dialog');page.once('dialog',dialog=>dialog.dismiss());await page.locator('#create').click();
  const after=await snapshot(page);expect(after.heights).toEqual(before.heights);expect([after.width,after.height,after.undoCount,after.redoCount]).toEqual([before.width,before.height,before.undoCount,before.redoCount]);expect((await state(page)).dirty).toBe(true);
});

test('exported revision becomes clean and undo redo track unsaved changes',async({page})=>{
  await stroke(page);const download=page.waitForEvent('download');await page.locator('#export').click();await download;
  expect((await state(page)).dirty).toBe(false);const saved=await snapshot(page);
  await stroke(page,22);expect((await state(page)).dirty).toBe(true);
  await page.locator('#undo').click();await expect.poll(async()=>(await state(page)).undoCount).toBe(1);expect((await state(page)).dirty).toBe(false);expect((await snapshot(page)).heights).toEqual(saved.heights);
  await page.locator('#redo').click();await expect.poll(async()=>(await state(page)).undoCount).toBe(2);expect((await state(page)).dirty).toBe(true);
});

test('discard history requires confirmation and preserves terrain and dirty state',async({page})=>{
  await stroke(page);const before=await snapshot(page);expect((await state(page)).dirty).toBe(true);
  page.removeAllListeners('dialog');page.once('dialog',dialog=>dialog.dismiss());await page.locator('#historyDiscard').click();
  expect((await state(page)).undoCount).toBe(1);expect((await snapshot(page)).heights).toEqual(before.heights);expect((await state(page)).dirty).toBe(true);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#historyDiscard').click();
  expect((await state(page)).undoCount).toBe(0);expect((await state(page)).redoCount).toBe(0);expect((await snapshot(page)).heights).toEqual(before.heights);expect((await state(page)).dirty).toBe(true);
});
