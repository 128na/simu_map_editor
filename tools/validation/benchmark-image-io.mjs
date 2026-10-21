import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../../',import.meta.url)));
mkdirSync('.validation',{recursive:true});
const channel=process.env.IMAGE_IO_BROWSER||'chrome';
if(!['chrome','msedge','chromium'].includes(channel))throw new Error('IMAGE_IO_BROWSER must be chrome, msedge or chromium');
import {createPerformanceMetadata} from './performance-metadata.mjs';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4185','--strictPort'],{stdio:'ignore',windowsHide:true});let browser;
const report={metadata:createPerformanceMetadata('image-io-worker-v1'),cases:[],limitations:['Flat zero-height map; actual Worker client path, excluding file dialogs and scene commit. Fixture generation excluded; named array estimates are not a measured peak.']};
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:4185')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch(channel==='chromium'?{}:{channel});
 report.browser={channel,version:browser.version()};
 for(const size of [4096,8192])for(const format of ['bmp','png']){
  const page=await browser.newPage();await page.goto('http://127.0.0.1:4185/');
  const result=await page.evaluate(async({size,format})=>{
   const codecs=await import('/src/codecs.ts'),terrain=await import('/src/terrain.ts');
   const profile=terrain.DEFAULT_PROFILE,map={width:size,height:size,heights:new Float32Array(size*size)};
   const {ImageIoClient}=await import('/src/image-io.ts');const client=new ImageIoClient();
   const fixture=format==='bmp'?codecs.exportBmp(map,profile):await codecs.exportPng(map,profile);
   const file=new File([fixture],'fixture.'+format);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
   const limits={maxTiles:terrain.LIMITS.maxTiles,maxFileBytes:terrain.LIMITS.maxFileBytes},events=[];
   const frames={running:true,last:0,gaps:[]};const tick=now=>{if(!frames.running)return;if(frames.last)frames.gaps.push(now-frames.last);frames.last=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);await new Promise(requestAnimationFrame);
   const encoded=await client.export(map,profile,format,limits,{onProgress:p=>events.push(p)});
   const decoded=await client.import(file,profile,limits,{onDimensions:()=>true,onProgress:p=>events.push(p)});
   await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);frames.running=false;client.dispose();
   if(decoded.changed!==0||map.heights.byteLength!==size*size*4)throw new Error('Worker semantic or ownership mismatch');
   return {size,format,exportTotalMs:encoded.totalMs,importTotalMs:decoded.totalMs,exportTimings:encoded.timings,importTimings:decoded.timings,exportArrays:encoded.arrays,importArrays:decoded.arrays,outputBytes:encoded.bytes.byteLength,normalizeChanged:decoded.changed,maxRafGapMs:Math.max(...frames.gaps),frameGaps:frames.gaps,events};
  },{size,format});report.cases.push(result);console.log(JSON.stringify({size,format,exportTotalMs:result.exportTotalMs,importTotalMs:result.importTotalMs,maxRafGapMs:result.maxRafGapMs}));writeFileSync('.validation/image-io-'+channel+'.json',JSON.stringify(report,null,2));await page.close();
 }
}finally{await browser?.close();server.kill();}
