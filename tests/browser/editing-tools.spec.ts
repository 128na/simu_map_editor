import {test,expect,type Page} from '@playwright/test';
const snapshot=(p:Page)=>p.evaluate(()=>(window as any).__validation.getSnapshot());
async function point(p:Page,x=16,y=16){return p.evaluate(({x,y})=>(window as any).__validation.projectSample(x,y),{x,y});}
test.beforeEach(async({page})=>{
 page.on('dialog',d=>void d.accept());await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
 await page.locator('#mode').selectOption('clamp');
 await page.evaluate(()=>(window as any).__validation.setMap({width:33,height:33,heights:new Float32Array(1089)}));
 await page.locator('#radius').fill('2');await page.locator('#top').click();
});

test('stationary hold raises repeatedly as one undo and Escape cancels the whole hold',async({page})=>{
 const at=await point(page);await page.mouse.move(at.x,at.y);await page.mouse.down();
 await expect.poll(async()=>(await snapshot(page)).heights[16+16*33]).toBeGreaterThanOrEqual(3);
 await page.mouse.up();
 const held=await snapshot(page);expect(held.undoCount).toBe(1);
 await expect(page.locator('#cursorPosition')).toContainText(`標高 ${(held.heights[544]+1).toFixed(1)}`);
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('造成を元に戻しました');expect((await snapshot(page)).heights).toEqual(new Array(1089).fill(0));
 const again=await point(page);await page.mouse.move(again.x,again.y);await page.mouse.down();await expect.poll(async()=>(await snapshot(page)).heights[544]).toBeGreaterThanOrEqual(2);
 await page.keyboard.press('Escape');await page.mouse.up();
 expect((await snapshot(page)).heights).toEqual(new Array(1089).fill(0));expect((await snapshot(page)).undoCount).toBe(0);
});

test('smoothing click applies one pass and undo restores the peak',async({page})=>{
 await page.evaluate(()=>{const h=new Float32Array(1089);for(const i of [544,543,545,511,577])h[i]=1;(window as any).__validation.setMap({width:33,height:33,heights:h});});
 await page.locator('#tool').selectOption('smooth');const before=await snapshot(page);const at=await point(page);
 await page.mouse.click(at.x,at.y);await expect(page.locator('#status')).toContainText('平滑化');
 const after=await snapshot(page);expect(after.heights[544]).toBe(0);expect(after.heights[543]).toBe(0);expect(after.undoCount).toBe(1);
 await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('造成を元に戻しました');expect((await snapshot(page)).heights).toEqual(before.heights);
});

test('cursor reads grid coordinates and height, grid changes rendering without changing terrain',async({page})=>{
 const errors:string[]=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const at=await point(page,12,14);await page.mouse.move(at.x,at.y);await expect(page.locator('#cursorPosition')).toContainText('X 12.0 / Y 14.0 / 標高 1.0');
 await page.mouse.move(10,10);await expect(page.locator('#cursorPosition')).toContainText('X —');
 const before=await snapshot(page),canvas=page.locator('#viewport canvas');
 const hidden=await canvas.screenshot();const metrics=await page.evaluate(()=>(window as any).__validation.getMetrics());
 await page.locator('#gridToggle').check();const visible=await canvas.screenshot();expect(visible.equals(hidden)).toBe(false);
 expect(await snapshot(page)).toEqual(before);expect((await page.evaluate(()=>(window as any).__validation.getMetrics())).geometryBytes).toBe(metrics.geometryBytes);
 expect((await page.evaluate(()=>(window as any).__validation.getMetrics())).gridVisible).toBe(true);
 await page.reload();await expect(page.locator('#gridToggle')).toBeChecked();expect(errors).toEqual([]);
});


test('multi-update drag keeps its path, cancels exactly and rolls back a rejected history entry',async({page})=>{
 const original=await snapshot(page);
 const points=await Promise.all([point(page,5,8),point(page,16,8),point(page,16,25)]);
 await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();
 for(const at of points.slice(1)){await page.mouse.move(at.x,at.y,{steps:4});await page.waitForTimeout(40);}
 const transient=await snapshot(page);
 expect(transient.heights[8*33+10]).toBe(1);expect(transient.heights[20*33+16]).toBe(1);
 await page.keyboard.press('Escape');await page.mouse.up();
 const cancelled=await snapshot(page);expect(cancelled.heights).toEqual(original.heights);expect(cancelled.grid).toEqual(original.grid);expect(cancelled.undoCount).toBe(0);
 await page.evaluate(()=>(window as any).__validation.configureHistory({ramBudgetBytes:1,diskBudgetBytes:1048576}));
 await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();
 for(const at of points.slice(1)){await page.mouse.move(at.x,at.y,{steps:4});await page.waitForTimeout(40);}
 await page.mouse.up();await expect(page.locator('#status')).toContainText('変更前へ戻しました');
 const rejected=await snapshot(page);expect(rejected.heights).toEqual(original.heights);expect(rejected.grid).toEqual(original.grid);expect(rejected.undoCount).toBe(0);
});
