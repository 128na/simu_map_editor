import {test,expect} from '@playwright/test';
test('startup flat terrain has no deep exterior walls',async({page},info)=>{
 await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
 const result=await page.evaluate(()=>{const a=(window as any).__validation;return {map:a.getSnapshot(),metrics:a.getMetrics()};});
 expect([result.map.width,result.map.height]).toEqual([128,128]);expect(result.map.grid.every((v:number)=>v===1)).toBe(true);
 expect(result.metrics.displayTriangles).toBe(128*128*2);
 await page.screenshot({path:`.validation/startup-flat-${info.project.name}.png`});
});
