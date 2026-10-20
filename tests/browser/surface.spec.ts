import {test,expect} from '@playwright/test';
test('startup flat terrain has no deep exterior walls',async({page},info)=>{
 await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
 const result=await page.evaluate(()=>{const a=(window as any).__validation;return {map:a.getSnapshot(),metrics:a.getMetrics()};});
 expect([result.map.width,result.map.height]).toEqual([128,128]);expect(result.map.grid.every((v:number)=>v===1)).toBe(true);
 expect(result.metrics.displayTriangles).toBe(128*128*2);
 await page.screenshot({path:`.validation/startup-flat-${info.project.name}.png`});
});


test('chunked terrain has no deep lattice and recent edits retain detail away from cursor',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
 await page.evaluate(()=>{const a=(window as any).__validation;a.setMap({width:1025,height:1025,heights:new Float32Array(1025*1025)});});
 let chunks=await page.evaluate(()=>(window as any).__validation.getDisplayChunks());
 expect(chunks.length).toBeGreaterThan(1);expect(chunks.every((c:any)=>c.minHeight===1&&c.maxHeight===1)).toBe(true);
 await page.evaluate(()=>(window as any).__validation.stroke({x:270,y:270,radius:8,amount:3,tool:'raise'}));
 await page.locator('#top').click();
 const distant=await page.evaluate(()=>(window as any).__validation.projectSample(900,900));await page.mouse.move(distant.x,distant.y);
 await expect.poll(async()=>{const c=await page.evaluate(()=>(window as any).__validation.getDisplayChunks());return c.find((c:any)=>c.x0===256&&c.y0===256)?.stride;}).toBe(1);
 chunks=await page.evaluate(()=>(window as any).__validation.getDisplayChunks());expect(chunks.every((c:any)=>c.minHeight>=1)).toBe(true);
 await page.locator('#oblique').click();await page.screenshot({path:`.validation/chunk-seams-${info.project.name}.png`});expect(errors).toEqual([]);
});
