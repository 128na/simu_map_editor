import {test,expect} from '@playwright/test';

test('built app works below a path prefix, including history worker and PNG roundtrip',async({page,baseURL})=>{
 const errors:string[]=[],failed:string[]=[],scripts:string[]=[];
 page.on('pageerror',e=>errors.push(String(e)));page.on('requestfailed',r=>failed.push(r.url()));
 page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('.js'))scripts.push(r.url());});
 page.on('dialog',d=>void d.accept());
 await page.goto('./?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
 await expect(page.locator('h1')).toHaveText('Simu Map Editor');await expect(page.locator('#viewport canvas')).toBeVisible();
 await expect(page.locator('html')).toHaveCSS('background-color','rgb(22, 34, 38)');
 await page.locator('#newWidth').fill('32');await page.locator('#newHeight').fill('32');await page.locator('#create').click();
 await expect(page.locator('#status')).toContainText('32 × 32');
 await page.evaluate(async()=>{const a=(window as any).__validation;a.stroke({x:16,y:16,radius:3,amount:3,tool:'raise'});await a.waitHistory();});
 const before=await page.evaluate(()=>(window as any).__validation.getSnapshot());expect(before.undoCount).toBe(1);
 expect((await page.evaluate(()=>(window as any).__validation.getHistoryState())).storedBytes).toBeGreaterThan(0);
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('元に戻しました');
 expect((await page.evaluate(()=>(window as any).__validation.getSnapshot())).heights.every((v:number)=>v===0)).toBe(true);
 await page.locator('#redo').click();await expect(page.locator('#status')).toContainText('やり直しました');
 const downloadReady=page.waitForEvent('download');await page.locator('#exportPng').click();const download=await downloadReady;
 const stream=await download.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);
 expect([...bytes.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
 await page.locator('#file').setInputFiles({name:'roundtrip.png',mimeType:'image/png',buffer:bytes});await expect(page.locator('#status')).toContainText('読み込み');
 const reloaded=await page.evaluate(()=>(window as any).__validation.getSnapshot());expect(reloaded.heights).toEqual(before.heights);expect(reloaded.grid).toEqual(before.grid);
 const prefix=new URL(baseURL!).pathname;expect(scripts.length).toBeGreaterThan(0);expect(scripts.every(url=>new URL(url).pathname.startsWith(prefix+'assets/'))).toBe(true);
 expect(scripts.some(url=>url.includes('history-worker'))).toBe(true);expect(errors).toEqual([]);expect(failed).toEqual([]);
});
