import {execFileSync} from 'node:child_process';
import {transformWithOxc} from 'vite';
import {test,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {createPerformanceMetadata} from '../../tools/validation/performance-metadata.mjs';
test.use({trace:'off'});
test('continuous sculpting update latency 4096',async({page,browser},info)=>{
 test.skip(!process.env.VALIDATE_INTERACTION,'Explicit interactive latency measurement');test.setTimeout(180000);
 const baselineRef=process.env.INTERACTION_BASELINE_REF;const overrideCounts:Record<string,number>={};
 if(baselineRef){
  if(!/^[0-9a-f]{7,40}$/.test(baselineRef))throw new Error('Baseline must be a commit SHA');
  for(const file of ['terrain-surface.ts','terrain.ts','grid-patch.ts']){
   const original=execFileSync('git',['show',`${baselineRef}:src/${file}`],{encoding:'utf8'});
   if(file==='terrain.ts'&&!original.includes('export function createBrushSession(')||file==='grid-patch.ts'&&!original.includes('export function prepareGridPatch('))throw new Error('Baseline module API is incompatible; measure that commit in its own checkout and retain the JSON before switching revisions');
   const transformed=await transformWithOxc(original,`src/${file}`);
   await page.route(`**/src/${file}`,async route=>{
    overrideCounts[file]=(overrideCounts[file]??0)+1;
    const actual=await route.fetch(),body=await actual.text();
    const three=body.match(/from\s*["']([^"']*\/three\.js[^"']*)["']/)?.[1];
    const code=three?transformed.code.replace(/from\s*["']three["']/g,`from ${JSON.stringify(three)}`):transformed.code;
    await route.fulfill({response:actual,body:code,contentType:'application/javascript'});
   });
  }
 }
 page.on('dialog',d=>void d.accept());await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
 await page.locator('#newWidth').fill('4096');await page.locator('#newHeight').fill('4096');await page.locator('#create').click();await expect(page.locator('#status')).toContainText('4096 × 4096');
 await page.locator('#top').click();await page.waitForTimeout(150);
 const points=await page.evaluate(()=>Array.from({length:41},(_,i)=>(window as any).__validation.projectSample(2048-120+i*6,2048+32+Math.sin(i/8)*24)));
 await page.evaluate(()=>{(window as any).__validation.resetInteractionUpdates();const state={running:true,last:0,intervals:[] as number[]};(window as any).__interactionFrames=state;const sample=(time:number)=>{if(!state.running)return;if(state.last)state.intervals.push(time-state.last);state.last=time;requestAnimationFrame(sample);};requestAnimationFrame(sample);});
 await page.mouse.move(points[0].x,points[0].y);const started=Date.now();await page.mouse.down();for(const p of points.slice(1))await page.mouse.move(p.x,p.y);await page.mouse.up();
 const result=await page.evaluate(()=>{(window as any).__interactionFrames.running=false;return {updates:(window as any).__validation.getInteractionUpdates(),frameIntervals:(window as any).__interactionFrames.intervals,metrics:(window as any).__validation.getMetrics(),history:(window as any).__validation.getHistoryState()};});
 expect(result.history.undoCount).toBe(1);expect(result.updates.length).toBeGreaterThan(5);
 const moves=result.updates.filter((u:any)=>u.kind==='move'),sorted=moves.map((u:any)=>u.totalMs).sort((a:number,b:number)=>a-b);
 const summary={medianUpdateMs:sorted[Math.floor(sorted.length*.5)],p95UpdateMs:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],maxUpdateMs:sorted.at(-1),firstUpdateMs:result.updates[0].totalMs};
 if(baselineRef)for(const file of ['terrain-surface.ts','terrain.ts','grid-patch.ts'])expect(overrideCounts[file]).toBeGreaterThan(0);
 const report={metadata:createPerformanceMetadata('interaction-v1'),browser:info.project.name,browserVersion:browser.version(),size:4096,conditions:{trial:info.repeatEachIndex+1,overrideCounts,baselineRef:baselineRef??null,overrides:baselineRef?['terrain-surface.ts','terrain.ts','grid-patch.ts']:[]},inputPoints:points.length,elapsedMs:Date.now()-started,summary,...result};
 writeFileSync(`.validation/interaction-${baselineRef?`baseline-${baselineRef}-`:""}${info.project.name}-4096-trial-${info.repeatEachIndex+1}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(summary));
});
