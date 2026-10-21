import {test,expect,type Page} from '@playwright/test';

const draws=(page:Page)=>page.evaluate(()=>(window as any).__draws as number);
async function settled(page:Page){
  await expect.poll(async()=>{const before=await draws(page);await page.waitForTimeout(150);return (await draws(page))-before;},{timeout:15000}).toBe(0);
}
test.beforeEach(async({page})=>{
  page.on('dialog',d=>void d.accept());await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
  await page.evaluate(()=>{
    (window as any).__draws=0;
    for(const name of ['drawElements','drawArrays'] as const){
      const original=WebGL2RenderingContext.prototype[name];
      (WebGL2RenderingContext.prototype as any)[name]=function(...args:any[]){(window as any).__draws++;return (original as any).apply(this,args);};
    }
  });
  await page.locator('#top').click();await settled(page);
});

test('idle drawing stops and grid, sculpting and undo still update actual pixels',async({page},info)=>{
  await page.addStyleTag({content:'#status,#cursorPosition{visibility:hidden}'});
  const canvas=page.locator('#viewport canvas'),before=await canvas.screenshot();
  const idle=await draws(page);await page.waitForTimeout(400);expect(await draws(page)).toBe(idle);
  await page.locator('#gridToggle').check();await expect.poll(()=>draws(page)).toBeGreaterThan(idle);
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  await page.locator('#gridToggle').uncheck();await settled(page);
  const flat=await canvas.screenshot();
  const at=await page.evaluate(()=>(window as any).__validation.projectSample(64,64));
  await page.mouse.click(at.x,at.y);await expect(page.locator('#status')).toContainText('造成完了');await page.mouse.move(10,10);await settled(page);
  expect((await canvas.screenshot()).equals(flat)).toBe(false);
  await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('元に戻しました');await settled(page);
  const restored=await canvas.screenshot();await info.attach('flat',{body:flat,contentType:'image/png'});await info.attach('restored',{body:restored,contentType:'image/png'});expect(restored.equals(flat)).toBe(true);
});

test('opposing arrows resume when one key is released, then drawing settles',async({page})=>{
  await page.keyboard.down('ArrowLeft');await page.keyboard.down('ArrowRight');await settled(page);
  const point=()=>page.evaluate(()=>(window as any).__validation.projectSample(64,64));
  const before=await point();await page.keyboard.up('ArrowLeft');
  await expect.poll(async()=>(await point()).x).toBeLessThan(before.x-2);
  await page.keyboard.up('ArrowRight');await settled(page);
  const count=await draws(page);await page.waitForTimeout(200);expect(await draws(page)).toBe(count);
});

test('visibility suspension retains changes and redraws when resumed',async({page})=>{
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  const before=await draws(page);await page.locator('#gridToggle').check();await page.waitForTimeout(150);expect(await draws(page)).toBe(before);
  await page.evaluate(()=>{delete (document as any).hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>draws(page)).toBeGreaterThan(before);await settled(page);
});
