import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createPerformanceMetadata } from '../../tools/validation/performance-metadata.mjs';
import { DEFAULT_PROFILE } from '../../src/terrain.ts';
const playwrightVersion = createRequire(import.meta.url)('@playwright/test/package.json').version;

test.use({trace:'off'});

const sizes=(process.env.PERF_SIZES??'1024,2048,4096').split(',').map(Number);
if(!sizes.length||sizes.some(n=>![256,512,1024,2048,4096].includes(n)))throw new Error('Invalid PERF_SIZES');
for(const size of sizes) test(`operation performance ${size}`,async({page,browser},info)=>{
 test.skip(!process.env.VALIDATE_OPERATIONS,'Explicit operation performance measurement');
 test.setTimeout(360000);
 await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
 const result:any={size,browser:info.project.name,browserVersion:browser.version(),playwrightVersion,metadata:createPerformanceMetadata('browser-v1'),conditions:{map:'flat',radius:8,amount:1,warmup:0,trials:3,profile:{...DEFAULT_PROFILE}}};
 await page.locator('#newWidth').fill(String(size));await page.locator('#newHeight').fill(String(size));
 const createStart=Date.now();await page.locator('#create').click({timeout:180000});
 await expect(page.locator('#status')).toContainText(`${size} × ${size}`,{timeout:180000});result.createMs=Date.now()-createStart;
 console.log(`created ${info.project.name} ${size}`);result.metrics=await page.evaluate(()=>(window as any).__validation.getMetrics());
 result.strokes=await page.evaluate(async(size)=>{
  const api=(window as any).__validation,out:any={};
  for(const tool of ['raise','lower','flatten']){
   const times=[];
   for(let i=0;i<3;i++){
    const t=performance.now();api.stroke({x:size/2+i*24,y:size/2,radius:8,amount:1,tool,...(tool==='flatten'?{target:1}:{})});
    times.push({ms:performance.now()-t,status:document.getElementById('status')!.textContent,timings:api.getTimings()});
    await new Promise<void>(r=>requestAnimationFrame(()=>r()));
   }out[tool]=times;
  }return out;
 },size);
 for(const entries of Object.values(result.strokes) as any[])for(const entry of entries)expect(entry.status).not.toContain('造成完了: 0画素');
 const action=async(id:string)=>{const t=Date.now();await page.locator(id).click({timeout:180000});await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));return Date.now()-t;};
 console.log(`strokes completed ${info.project.name} ${size}`);result.undoMs=await action('#undo');result.redoMs=await action('#redo');
 await page.locator('#top').click();await page.waitForTimeout(250);
 const points=await page.evaluate(size=>Array.from({length:7},(_,i)=>(window as any).__validation.projectSample(size/2-24+i*8,size/2+32)),size);
 await page.evaluate(()=>{document.getElementById('status')!.textContent='';});
 const t=Date.now();await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();
 for(const p of points.slice(1))await page.mouse.move(p.x,p.y);
 await page.mouse.up();await expect(page.locator('#status')).toContainText('固定標高',{timeout:180000});
 result.dragMs=Date.now()-t;result.dragInputPoints=points.length;
 const box=(await page.locator('canvas').boundingBox())!;
 const rotateStart=Date.now();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down({button:'right'});await page.mouse.move(box.x+box.width/2+100,box.y+box.height/2+30,{steps:10});await page.mouse.up({button:'right'});result.rotateMs=Date.now()-rotateStart;
 result.frameIntervals=await page.evaluate(async()=>{const times:number[]=[];let last=performance.now();for(let i=0;i<30;i++){await new Promise<void>(r=>requestAnimationFrame(()=>r()));const now=performance.now();times.push(now-last);last=now;}return times.slice(1);});
 result.memory=await page.evaluate(()=>{const m=(performance as any).memory;return m?{usedJSHeapSize:m.usedJSHeapSize,totalJSHeapSize:m.totalJSHeapSize,jsHeapSizeLimit:m.jsHeapSizeLimit}:null;});
 mkdirSync(resolve('.validation'),{recursive:true});writeFileSync(resolve(`.validation/operations-${info.project.name}-${size}.json`),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
 if(process.env.DRAG_BUDGET_MS&&size===4096){const budget=Number(process.env.DRAG_BUDGET_MS);expect(Number.isFinite(budget)&&budget>0).toBe(true);expect(result.dragMs).toBeLessThanOrEqual(budget);}
});
