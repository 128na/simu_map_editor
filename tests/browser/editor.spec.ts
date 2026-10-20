import {test,expect} from '@playwright/test';

test.beforeEach(async({page})=>{
 page.on('dialog',dialog=>void dialog.accept());
 await page.goto('/');
 await expect(page.locator('#status')).toContainText('平坦な地形で開始');
});

test('editor starts with an empty map and tracks edits and exported filename',async({page})=>{
 await expect(page).toHaveTitle('新規マップ — Simu Map Editor');
 await page.locator('#newWidth').fill('32');await page.locator('#newHeight').fill('24');await page.locator('#create').click();
 await expect(page.locator('#documentState')).toHaveText('新規マップ · 32 × 24 · 未保存');
 const pending=page.waitForEvent('download');await page.locator('#export').click();const download=await pending;
 expect(download.suggestedFilename()).toBe('simutrans-heightmap.bmp');
 await expect(page.locator('#documentState')).not.toContainText('未保存');
 const stream=await download.createReadStream();const chunks:Buffer[]=[];for await(const part of stream!)chunks.push(part);
 await page.locator('#file').setInputFiles({name:'my-terrain.bmp',mimeType:'image/bmp',buffer:Buffer.concat(chunks)});
 await expect(page.locator('#documentState')).toHaveText('my-terrain.bmp · 32 × 24');
 await page.locator('#file').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('broken')});
 await expect(page.locator('#status')).toHaveClass(/error/);
 await expect(page.locator('#documentState')).toHaveText('my-terrain.bmp · 32 × 24');
 page.removeAllListeners('dialog');page.once('dialog',dialog=>void dialog.dismiss());
 await page.locator('#file').setInputFiles({name:'canceled.bmp',mimeType:'image/bmp',buffer:Buffer.concat(chunks)});
 await expect(page.locator('#status')).toContainText('取り消しました');
 await expect(page.locator('#documentState')).toHaveText('my-terrain.bmp · 32 × 24');
 page.on('dialog',dialog=>void dialog.accept());
 await page.locator('#top').click();
 const canvas=page.locator('#viewport canvas');await canvas.click({position:{x:400,y:350}});
 await expect(page.locator('#status')).toContainText('造成完了');
 await expect(page.locator('#documentState')).toContainText('未保存');
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('造成を元に戻しました');
 await expect(page.locator('#documentState')).not.toContainText('未保存');
 const again=page.waitForEvent('download');await page.locator('#export').click();expect((await again).suggestedFilename()).toBe('my-terrain.bmp');
});

test('brush settings survive reload while map settings stay explicit',async({page})=>{
 await page.locator('#tool').selectOption('lower');await page.locator('#radius').fill('13');await page.locator('#radius').dispatchEvent('change');
 await page.locator('#amount').fill('3');await page.locator('#amount').dispatchEvent('change');await page.locator('#top').click();
 await page.locator('#mode').selectOption('clamp');await page.reload();
 await expect(page.locator('#tool')).toHaveValue('lower');await expect(page.locator('#radius')).toHaveValue('13');await expect(page.locator('#radiusValue')).toHaveText('13');await expect(page.locator('#amount')).toHaveValue('3');
 await expect(page.locator('#mode')).toHaveValue('linear');
 await expect(page.locator('#documentState')).toHaveText('新規マップ · 128 × 128');
});

test('PNG download preserves terrain and cleans only a successful export',async({page})=>{
 await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
 await page.evaluate(()=>{const a=(window as any).__validation;a.setMap({width:9,height:5,heights:Float32Array.from({length:45},(_,i)=>Math.floor((i%9+Math.floor(i/9))/2)-3)});});
 const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());
 const dirty=await page.evaluate(()=>(window as any).__validation.getHistoryState().dirty);expect(dirty).toBe(true);
 await page.evaluate(()=>{(window as any).__compressionBackup=CompressionStream;(window as any).CompressionStream=class {constructor(){throw new Error('PNG compression failed');}};});
 await page.locator('#exportPng').click();await expect(page.locator('#status')).toContainText('PNG compression failed');
 expect(await page.evaluate(()=>(window as any).__validation.getHistoryState().dirty)).toBe(true);
 expect(await page.evaluate(()=>(window as any).__validation.getSnapshot())).toEqual(before);
 await page.evaluate(()=>{(window as any).CompressionStream=(window as any).__compressionBackup;});
 const pending=page.waitForEvent('download');await page.locator('#exportPng').click();const download=await pending;expect(download.suggestedFilename()).toBe('simutrans-heightmap.png');
 const stream=await download.createReadStream();const chunks:Buffer[]=[];for await(const part of stream!)chunks.push(part);const bytes=Buffer.concat(chunks);
 expect([...bytes.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
 expect(await page.evaluate(()=>(window as any).__validation.getHistoryState().dirty)).toBe(false);
 await page.locator('#file').setInputFiles({name:'roundtrip.png',mimeType:'image/png',buffer:bytes});await expect(page.locator('#status')).toContainText('補正はありません');
 expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).grid).toEqual(before.grid);
});
