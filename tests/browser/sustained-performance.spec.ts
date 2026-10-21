import {test,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createPerformanceMetadata} from '../../tools/validation/performance-metadata.mjs';
import {DEFAULT_PROFILE} from '../../src/terrain.ts';

type Phase={name:string;atMs:number;durationMs:number};
type Cycle={index:number;tool:string;atMs:number;durationMs?:number;phases:Phase[];timings?:Record<string,number>;updates?:unknown[];queued?:unknown;settled?:unknown;metrics?:any;heap?:any;changed?:boolean;undoTimings?:Record<string,number>;redoTimings?:Record<string,number>;undoVerified?:boolean};
type Frame={atMs:number;gapMs:number;cycle:number;phase:string};
const integer=(name:string,fallback:number,min:number,max:number)=>{
  const value=Number(process.env[name]??fallback);
  if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
};
const quantiles=(values:number[])=>{
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  const at=(q:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]:null;
  return {count:sorted.length,median:at(.5),p95:at(.95),max:sorted.at(-1)??null};
};
function sourceHashes(){
  const paths=readdirSync('src').filter(name=>/\.(ts|css)$/.test(name)).map(name=>join('src',name)).concat(['playwright.sustained.config.ts','tests/browser/sustained-performance.spec.ts']).sort();
  const files=Object.fromEntries(paths.map(path=>[path.replaceAll('\\','/'),createHash('sha256').update(readFileSync(path)).digest('hex')]));
  return {files,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}

test('sustained real drag and history workload records chronological latency and memory samples',async({page,browser},info)=>{
  test.skip(!info.project.name.startsWith('sustained-'),'Local opt-in: npm run benchmark:sustained');
  const size=integer('SUSTAINED_SIZE',4096,256,8192),seconds=integer('SUSTAINED_SECONDS',60,1,900);
  const minimumCycles=integer('SUSTAINED_CYCLES',12,2,300),radius=integer('SUSTAINED_RADIUS',40,1,256),amount=integer('SUSTAINED_AMOUNT',1,1,8);
  const maximumCycles=integer('SUSTAINED_MAX_CYCLES',3000,minimumCycles,10000);
  const terrain=process.env.SUSTAINED_TERRAIN??'flat';
  if(!['flat','coast','slopes'].includes(terrain))throw new Error('SUSTAINED_TERRAIN must be flat, coast or slopes');
  const pattern=process.env.SUSTAINED_PATTERN??'raise-lower',path=process.env.SUSTAINED_PATH??'sweep';
  const smoothingRadius=integer('SUSTAINED_SMOOTHING_RADIUS',4,1,16),smoothingMode=process.env.SUSTAINED_SMOOTHING_MODE??'surface';
  if(!['raise-lower','raise-smooth'].includes(pattern)||!['sweep','reversal'].includes(path)||!['surface','slope'].includes(smoothingMode))throw new Error('Invalid sustained pattern, path or smoothing mode');
  test.setTimeout(seconds*1000+240000);
  const cycles:Cycle[]=[],frames:Frame[]=[];
  const report:any={schemaVersion:1,metadata:createPerformanceMetadata('sustained-v3'),sources:sourceHashes(),browser:info.project.name,browserVersion:browser.version(),
    conditions:{size,seconds,minimumCycles,maximumCycles,radius,amount,pattern,path,smoothingRadius,smoothingMode,profile:{...DEFAULT_PROFILE},map:terrain,input:'real nine-point mouse drag',undoRedoEvery:3,warmupCycles:0},cycles,frames,
    completed:false,endReason:'setup-failed',windowGrouping:'chronological cycle-count thirds (not equal elapsed-time bands)',
    timebases:{cycleAtMs:'Node monotonic milliseconds since workload start',phaseAndFrameAtMs:'Browser monotonic milliseconds since frame recorder origin',durationMs:'Node monotonic durations around actions'},limitations:[
      'Phase durations include Playwright transport and UI waits; synchronous history timings and interaction updates are recorded separately.',
      'Digest verification scans source and grid outside timed undo/redo phases; its cost is included in cycle elapsed time.',
      'requestAnimationFrame gaps measure main-thread availability, not rendered fps (the renderer can sleep).',
      'performance.memory is Chromium-specific, coarse and shared; sampled JS heap excludes GPU, Worker and much ArrayBuffer memory. The sampled peak is not a process-memory peak.',
      'raise-smooth records legitimate no-op cycles separately; only changed cycles verify Undo/Redo and contribute synchronous edit timings.',
      'No speed threshold or improvement claim; compare the same browser, renderer, workload and source revision.',
    ]};
  let started=0;
  page.on('dialog',dialog=>void dialog.accept());
  try{
    await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
    await page.locator('#newWidth').fill(String(size));await page.locator('#newHeight').fill(String(size));
    await page.locator('#create').click({timeout:180000});await expect(page.locator('#status')).toContainText(`${size} × ${size}`,{timeout:180000});
    if(terrain!=='flat')await page.evaluate(({size,terrain})=>{
      const heights=new Float32Array(size*size);
      for(let y=0;y<size;y++)for(let x=0;x<size;x++){
        // Integer, neighboring changes <= 1; deterministic coast or full-range slope bands.
        heights[x+y*size]=terrain==='coast'?Math.round(4*Math.sin(x/64)+3*Math.cos(y/96)):
          Math.round(10+22*Math.sin(x/192)*Math.cos(y/256));
      }
      (window as any).__validation.setMap({width:size,height:size,heights});
    },{size,terrain});
    if(radius>40){await page.locator('#resourceSettings > summary').click();await page.locator('#maxBrushRadius').fill(String(radius));await page.locator('#applySettings').click();}
    await page.locator('#tool').selectOption('smooth');await page.locator('#smoothingRadius').fill(String(smoothingRadius));await page.locator('#smoothingRadius').dispatchEvent('change');await page.locator('#smoothingMode').selectOption(smoothingMode);
    await page.evaluate(maxEntries=>(window as any).__validation.configureHistory({maxEntries,ramBudgetBytes:64*1048576,diskBudgetBytes:512*1048576}),maximumCycles);
    report.historyOptions={maxEntries:maximumCycles,ramBudgetBytes:64*1048576,diskBudgetBytes:512*1048576};
    await page.locator('#top').click();await page.locator('#radius').fill(String(radius));await page.locator('#amount').fill(String(amount));
    report.initialMetrics=await page.evaluate(()=>(window as any).__validation.getMetrics());
    report.resourceSettings=await page.evaluate(()=>(window as any).__validation.getEditorSettings());
    report.knownResidentArrays={sourceHeightsBytes:size*size*4,renderGridBytes:(size+1)*(size+1)*2,note:'Named persistent CPU arrays only; geometry is recorded separately; Worker/browser/GPU/temporary allocations excluded'};
    await page.evaluate(()=>{
      const sample={running:true,origin:performance.now(),last:0,cycle:-1,phase:'setup',frames:[] as Frame[]};
      (window as any).__sustainedFrames=sample;
      const tick=(now:number)=>{if(!sample.running)return;if(sample.last)sample.frames.push({atMs:now-sample.origin,gapMs:now-sample.last,cycle:sample.cycle,phase:sample.phase});sample.last=now;requestAnimationFrame(tick);};
      requestAnimationFrame(tick);
    });
    started=performance.now();
    for(let index=0;index<maximumCycles;index++){
      const cycle:Cycle={index,tool:index%2?(pattern==='raise-smooth'?'smooth':'lower'):'raise',atMs:performance.now()-started,phases:[]};cycles.push(cycle);
      const cycleStarted=performance.now();
      const phase=async<T>(name:string,action:()=>Promise<T>)=>{
        const atMs=await page.evaluate(({name,index})=>{const state=(window as any).__sustainedFrames;state.phase=name;state.cycle=index;return performance.now()-state.origin;},{name,index});
        const began=performance.now();try{return await action();}finally{cycle.phases.push({name,atMs,durationMs:performance.now()-began});}
      };
      const points=await phase('prepare',async()=>{
        await page.locator('#tool').selectOption(cycle.tool);
        return page.evaluate(({size,radius,index,path})=>{
          const group=Math.floor(index/2)%9,cx=size*(.35+(group%3)*.15),cy=size*(.35+Math.floor(group/3)*.15);
          const span=Math.min(size*.12,Math.max(radius*3,32));
          return Array.from({length:9},(_,i)=>(window as any).__validation.projectSample(cx-span+(path==='reversal'?Math.min(i,8-i)*span/2:i*span/4),cy+Math.sin(i/2)*Math.min(radius/2,size*.025)));
        },{size,radius,index,path});
      });
      const before=await page.evaluate(()=>(window as any).__validation.getHistoryState());
      const beforeDigest=pattern==='raise-smooth'?await phase('no-op-digest-before',()=>page.evaluate(()=>(window as any).__validation.getMapDigest())):undefined;
      await page.evaluate(()=>(window as any).__validation.resetInteractionUpdates());
      await phase('drag',async()=>{
        await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();
        for(const point of points.slice(1))await page.mouse.move(point.x,point.y);
        await page.mouse.up();
      });
      const after=await page.evaluate(()=>{const api=(window as any).__validation;return {history:api.getHistoryState(),timings:api.getTimings(),updates:api.getInteractionUpdates()};});
      const increment=after.history.undoCount-before.undoCount;
      if(pattern==='raise-smooth')expect([0,1]).toContain(increment);else expect(increment).toBe(1);
      expect(after.history.failed).toBe(false);const changed=increment===1;
      if(changed){expect(after.updates.length).toBeGreaterThan(0);cycle.timings=after.timings;}
      else{expect(beforeDigest).toBeDefined();expect(await phase('no-op-digest-after',()=>page.evaluate(()=>(window as any).__validation.getMapDigest()))).toEqual(beforeDigest);}
      cycle.changed=changed;cycle.updates=after.updates;cycle.queued=after.history;
      await phase('history-drain',()=>page.evaluate(()=>(window as any).__validation.waitHistory()));
      const settled=await page.evaluate(()=>(window as any).__validation.getHistoryState());
      expect(settled.queuedBytes).toBe(0);expect(settled.failed).toBe(false);expect(settled.storedBytes).toBeGreaterThan(0);cycle.settled=settled;
      if(index%3===0&&cycle.changed){
        const digest=await phase('digest-before',()=>page.evaluate(()=>(window as any).__validation.getMapDigest()));
        await phase('undo',async()=>{await page.locator('#undo').click();await expect(page.locator('#status')).toContainText('元に戻しました');});
        cycle.undoTimings=await page.evaluate(()=>(window as any).__validation.getTimings());
        const undone=await phase('digest-undone',()=>page.evaluate(()=>(window as any).__validation.getMapDigest()));expect(undone).not.toEqual(digest);
        await phase('redo',async()=>{await page.locator('#redo').click();await expect(page.locator('#status')).toContainText('やり直しました');});
        cycle.redoTimings=await page.evaluate(()=>(window as any).__validation.getTimings());
        const redone=await phase('digest-redone',()=>page.evaluate(()=>(window as any).__validation.getMapDigest()));expect(redone).toEqual(digest);cycle.undoVerified=true;
      }
      const resource=await page.evaluate(()=>{const memory=(performance as any).memory;return {metrics:(window as any).__validation.getMetrics(),heap:memory?{usedJSHeapSize:memory.usedJSHeapSize,totalJSHeapSize:memory.totalJSHeapSize,jsHeapSizeLimit:memory.jsHeapSizeLimit}:null};});
      cycle.metrics=resource.metrics;cycle.heap=resource.heap;cycle.durationMs=performance.now()-cycleStarted;
      const elapsedMs=performance.now()-started;
      if(cycles.length>=minimumCycles&&elapsedMs>=seconds*1000){report.completed=true;report.endReason='duration-and-minimum-cycles';break;}
    }
    if(!report.completed)report.endReason='cycle-cap-before-duration';
    expect(cycles.length).toBeGreaterThanOrEqual(minimumCycles);
    expect(cycles.some(cycle=>cycle.changed)).toBe(true);
    report.workloadElapsedMs=performance.now()-started;
    await page.evaluate(()=>{(window as any).__sustainedFrames.running=false;});
    if(report.completed){
      const before=await page.evaluate(()=>(window as any).__validation.getMapDigest());
      report.historyBeforeRoundTrip=await page.evaluate(()=>(window as any).__validation.getHistoryState());
      const ready=page.waitForEvent('download');await page.locator('#exportPng').click();const download=await ready;
      const stream=await download.createReadStream(),chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));
      await page.locator('#file').setInputFiles({name:'sustained-roundtrip.png',mimeType:'image/png',buffer:Buffer.concat(chunks)});
      await expect(page.locator('#status')).toContainText('sustained-roundtrip.png を読み込みました',{timeout:180000});
      const after=await page.evaluate(()=>(window as any).__validation.getMapDigest());expect(after).toEqual(before);report.pngRoundTripVerified=true;
    }
  }catch(error){report.completed=false;report.failure=error instanceof Error?error.stack:String(error);report.endReason=started?'workload-failed':'setup-failed';throw error;}
  finally{
    report.elapsedMs=started?performance.now()-started:0;
    try{frames.push(...await page.evaluate(()=>{const state=(window as any).__sustainedFrames;if(!state)return [];state.running=false;return state.frames;}));}catch(error){report.collectionError=String(error);}
    const windows=['early','middle','late'].map((name,i)=>{
      const subset=cycles.slice(Math.floor(cycles.length*i/3),Math.floor(cycles.length*(i+1)/3));
      const ids=new Set(subset.map(c=>c.index)),gaps=frames.filter(f=>ids.has(f.cycle));
      const phaseNames=[...new Set(subset.flatMap(c=>c.phases.map(p=>p.name)))];
      return {name,changedCycles:subset.filter(c=>c.changed).length,noOpCycles:subset.filter(c=>c.changed===false).length,unfinishedCycles:subset.filter(c=>c.changed===undefined).length,changedDragMs:quantiles(subset.filter(c=>c.changed).flatMap(c=>c.phases.filter(p=>p.name==='drag').map(p=>p.durationMs))),noOpDragMs:quantiles(subset.filter(c=>c.changed===false).flatMap(c=>c.phases.filter(p=>p.name==='drag').map(p=>p.durationMs))),cycleIndices:subset.map(c=>c.index),cycleMs:quantiles(subset.flatMap(c=>c.durationMs===undefined?[]:[c.durationMs])),
        phases:Object.fromEntries(phaseNames.map(phase=>[phase,quantiles(subset.flatMap(c=>c.phases.filter(p=>p.name===phase).map(p=>p.durationMs)))])),
        historyPatchMs:quantiles(subset.map(c=>c.timings?.historyPatchMs??NaN)),historyRecordMs:quantiles(subset.map(c=>c.timings?.historyRecordMs??NaN)),
        frameGapMs:quantiles(gaps.map(f=>f.gapMs)),sampledPeakJSHeapBytes:Math.max(0,...subset.map(c=>c.heap?.usedJSHeapSize??0))||null};
    });
    report.windows=windows;
    report.summary={cycles:cycles.length,changedCycles:cycles.filter(c=>c.changed).length,noOpCycles:cycles.filter(c=>c.changed===false).length,unfinishedCycles:cycles.filter(c=>c.changed===undefined).length,undoChecks:cycles.filter(c=>c.undoVerified).length,historyPatchMs:quantiles(cycles.map(c=>c.timings?.historyPatchMs??NaN)),historyRecordMs:quantiles(cycles.map(c=>c.timings?.historyRecordMs??NaN)),frameGapMs:quantiles(frames.map(f=>f.gapMs)),sampledPeakJSHeapBytes:Math.max(0,...cycles.map(c=>c.heap?.usedJSHeapSize??0))||null};
    mkdirSync('.validation',{recursive:true});const path=`.validation/sustained-${info.project.name}-${size}-${Date.now()}.json`;
    writeFileSync(path,JSON.stringify(report,null,2));console.log(JSON.stringify({path,completed:report.completed,endReason:report.endReason,elapsedMs:report.elapsedMs,...report.summary}));
  }
});
