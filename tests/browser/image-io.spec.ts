import {test,expect,type Page} from '@playwright/test';
import {exportBmp} from '../../src/codecs.ts';
import {DEFAULT_PROFILE} from '../../src/terrain.ts';

const workerPath=/\/src\/image-io-worker\.ts(?:\?.*)?$/;
const image={name:'incoming.bmp',mimeType:'image/bmp',buffer:Buffer.from(exportBmp({width:17,height:13,heights:Float32Array.from({length:17*13},(_,i)=>Math.floor((i%17+Math.floor(i/17))/3))},DEFAULT_PROFILE))};
const slowRead=`const originalRead=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async function(){await new Promise(resolve=>setTimeout(resolve,1200));return originalRead.call(this);};\n`;
const slowCompression=`const OriginalCompressionStream=self.CompressionStream;self.CompressionStream=class extends OriginalCompressionStream {constructor(format){const until=performance.now()+1200;while(performance.now()<until){}super(format);}};\n`;
async function inject(page:Page,source:string){
  await page.route(workerPath,async route=>{const response=await route.fetch();await route.fulfill({response,body:source+await response.text(),contentType:'application/javascript'});});
}
const preserved=(page:Page)=>page.evaluate(()=>{
  const api=(window as any).__validation;
  return {map:api.getSnapshot(),history:api.getHistoryState(),document:document.getElementById('documentState')!.textContent,title:document.title};
});
const state=(page:Page)=>page.evaluate(()=>(window as any).__validation.getImageIoState());
async function saveClean(page:Page){
  const download=page.waitForEvent('download');await page.locator('#export').click();await download;
  await expect(page.locator('#documentState')).not.toContainText('未保存');
}
test.beforeEach(async({page})=>{
  page.on('dialog',dialog=>void dialog.accept());await page.goto('/?validate=1');await page.waitForFunction(()=>!!(window as any).__validation);
  await page.evaluate(async()=>{const api=(window as any).__validation;api.setMap({width:33,height:33,heights:new Float32Array(1089)});api.stroke({x:16,y:16,radius:2,amount:1,tool:'raise'});await api.waitHistory();});
});

for(const clean of [false,true])test(`import cancellation preserves ${clean?'saved':'unsaved'} terrain, profile and history, and same file retries`,async({page})=>{
  if(clean)await saveClean(page);
  const before=await preserved(page);await inject(page,slowRead);
  await page.locator('#file').setInputFiles(image);
  await expect(page.locator('#fileOperation')).toBeVisible();await expect(page.locator('#fileOperationStage')).toContainText('画像ファイルを読み込んでいます');
  await expect(page.locator('#cancelFileOperation')).toBeEnabled();await expect(page.locator('#create')).toBeDisabled();
  await page.locator('#cancelFileOperation').click();await expect(page.locator('#status')).toContainText('取り消しました');await expect(page.locator('#fileOperation')).toBeHidden();
  expect(await preserved(page)).toEqual(before);expect((await state(page)).last.state).toBe('cancelled');
  await page.unroute(workerPath);await page.locator('#file').setInputFiles(image);
  await expect(page.locator('#status')).toContainText('incoming.bmp を読み込みました');
  const after=await preserved(page);expect(after.map.width).toBe(17);expect(after.map.height).toBe(13);expect(after.map.undoCount).toBe(0);
  expect((await state(page)).last.progress.map((entry:any)=>entry.stage)).toEqual(['read','inspect','confirm-dimensions','decode','normalize','complete']);
});

test('Escape cancels actual Worker compression without download or clearing dirty history',async({page})=>{
  const before=await preserved(page),downloads:string[]=[];page.on('download',download=>downloads.push(download.suggestedFilename()));
  await inject(page,slowCompression);await page.locator('#exportPng').click();
  await expect(page.locator('#fileOperationStage')).toContainText('PNG画像を作成しています');await expect(page.locator('#cancelFileOperation')).toBeEnabled();
  await page.keyboard.press('Escape');await expect(page.locator('#status')).toContainText('取り消しました');await expect(page.locator('#fileOperation')).toBeHidden();
  expect(await preserved(page)).toEqual(before);expect(downloads).toEqual([]);expect((await state(page)).last.state).toBe('cancelled');
  await page.unroute(workerPath);const ready=page.waitForEvent('download');await page.locator('#exportPng').click();expect((await ready).suggestedFilename()).toMatch(/\.png$/);
  await expect(page.locator('#documentState')).not.toContainText('未保存');expect((await state(page)).last.state).toBe('completed');
});

test('external map replacement cancels the old import and late completion cannot overwrite the replacement',async({page})=>{
  await inject(page,slowRead);await page.locator('#file').setInputFiles(image);await expect(page.locator('#fileOperationStage')).toContainText('画像ファイルを読み込んでいます');
  await page.evaluate(()=>(window as any).__validation.setMap({width:9,height:7,heights:new Float32Array(63).fill(2)}));
  await expect(page.locator('#fileOperation')).toBeHidden();const replacement=await preserved(page);
  expect(replacement.map.width).toBe(9);expect(replacement.map.height).toBe(7);expect(replacement.map.undoCount).toBe(0);
  await page.waitForTimeout(1400);expect(await preserved(page)).toEqual(replacement);expect((await state(page)).active).toBe(false);
  await page.unroute(workerPath);await page.locator('#file').setInputFiles(image);await expect(page.locator('#status')).toContainText('incoming.bmp を読み込みました');
  expect((await preserved(page)).map.width).toBe(17);
});

for(const failure of ['allocation','startup'] as const)test(`actual Worker ${failure} failure preserves state and permits retry`,async({page})=>{
  const before=await preserved(page);
  await inject(page,failure==='allocation'?"File.prototype.arrayBuffer=async()=>{throw new RangeError('simulated allocation failure');};\n":"throw new Error('simulated Worker startup failure');\n");
  await page.locator('#file').setInputFiles(image);await expect(page.locator('#status')).toContainText(failure==='allocation'?'simulated allocation failure':'simulated Worker startup failure');
  await expect(page.locator('#fileOperation')).toBeHidden();expect(await preserved(page)).toEqual(before);expect((await state(page)).last.state).toBe('failed');
  await expect(page.locator('#file')).toBeEnabled();await page.unroute(workerPath);await page.locator('#file').setInputFiles(image);await expect(page.locator('#status')).toContainText('incoming.bmp を読み込みました');
});

test('failed export leaves the map unsaved and successful PNG retry round-trips the exact grid',async({page})=>{
  const before=await preserved(page);
  await inject(page,"self.CompressionStream=class {constructor(){throw new RangeError('simulated output allocation failure');}};\n");
  await page.locator('#exportPng').click();await expect(page.locator('#status')).toContainText('simulated output allocation failure');
  expect(await preserved(page)).toEqual(before);expect((await state(page)).last.state).toBe('failed');
  await page.unroute(workerPath);const ready=page.waitForEvent('download');await page.locator('#exportPng').click();const download=await ready;
  const stream=await download.createReadStream(),chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);
  expect([...bytes.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);await expect(page.locator('#documentState')).not.toContainText('未保存');
  await page.locator('#file').setInputFiles({name:'roundtrip.png',mimeType:'image/png',buffer:bytes});await expect(page.locator('#status')).toContainText('roundtrip.png を読み込みました');
  const reloaded=(await preserved(page)).map;expect(reloaded.heights).toEqual(before.map.heights);expect(reloaded.grid).toEqual(before.map.grid);expect(reloaded.profile).toEqual(before.map.profile);
});
