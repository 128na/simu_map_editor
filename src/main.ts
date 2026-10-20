import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEFAULT_PROFILE, decodeSample, toGrid, applyBrush, applyBrushIncremental, type DirtyBounds, quantizationReport, validateDimensions, type Heightmap, type Profile } from './terrain';
import { importHeightmap, exportBmp } from './codecs';
import { createWaterMesh } from './water';
import { intersectTerrain } from './picking';
import { terrainGeometry } from './terrain-geometry';
import { patchGrid, waterChanged } from './grid-patch';
import { AsyncHistory, createPatch, HistoryBudgetError, type HistoryOptions, type HistoryStore } from './history';
import { BrowserHistoryStore } from './history-store';
import './style.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><div><h1>Simutrans / 地形検証</h1><p>画像 → 標高 → 斜面補正 → 3D表示 → BMP書出の試作</p></div><small>ローカルファイルのみ・バックエンドなし</small></header>
<main><aside>
<section><h2>01　ファイル</h2><div class="row"><label>幅（タイル）<input id="newWidth" type="number" min="1" max="4096" step="1" value="128"></label><label>高さ（タイル）<input id="newHeight" type="number" min="1" max="4096" step="1" value="128"></label></div><button id="create" style="width:100%">指定サイズで新規作成</button><small>表示標高1の平坦な地形で開始。現在の地形とUndo履歴を置き換えます。</small><label class="file">マップ画像を開く<input id="file" type="file" accept=".bmp,.png,.ppm"></label><button id="export" style="width:100%">BMPを書き出す</button><small id="quantization"></small><small>上限: 16,777,216画素 / 各辺4,096<br>水面メッシュ上限16 MiB。入力エラー時も現在の地形を保持します。</small></section>
<section><h2>02　造成</h2><label>ツール<select id="tool"><option value="raise">盛り上げる</option><option value="lower">掘り下げる</option><option value="flatten">平坦化</option></select></label><label>ブラシ半径 <span id="radiusValue">8</span><input id="radius" type="range" min="1" max="40" value="8"></label><label>強さ<input id="amount" type="number" min="1" max="8" step="1" value="1"></label><label>ドラッグの固定標高<output id="dragHeight">開始点で決定</output></label><div class="row"><button id="undo">元に戻す</button><button id="redo">やり直す</button></div><small id="historyState"></small><div class="row"><button id="historyDiscard">履歴を破棄</button><button id="historyMemory" hidden>RAMのみで続行</button></div><div class="row"><label>退避待ちRAM<select id="historyRam"><option value="16">16 MiB</option><option value="64" selected>64 MiB</option><option value="256">256 MiB</option></select></label><label>履歴全体<select id="historyDisk"><option value="128">128 MiB</option><option value="512" selected>512 MiB</option><option value="1024">1 GiB</option></select></label></div><small>保存は非同期。Undo中は操作を待機します。容量不足時も地形を保持し、履歴破棄は確認後に行います。</small><small>左ドラッグで連続造成。盛土・掘削は押し始めの高さ±強さ、平坦化は押し始めの高さで固定。右ドラッグで回転、ホイールでズーム。補正はブラシ外へ波及します。</small></section>
<section><h2>03　互換設定</h2><label>高さ変換<select id="mode"><option value="linear">Linear</option><option value="clamp">Clamp</option><option value="legacy-small">Legacy small</option><option value="legacy-large">Legacy large</option></select></label><div class="row"><label>高さ係数<select id="factor"><option value="1">1</option><option value="2">2</option></select></label><label>最大斜面<select id="maxSlope"><option value="1">1段</option><option value="2">2段</option></select></label></div><label>海面<input id="seaLevel" type="number" min="-12" max="32" value="0"></label><small>変換範囲: −12〜32<br>設定変更は取り込み済みの編集標高を維持。Undo履歴はリセットします。</small></section>
<section><h2>04　表示</h2><div class="row"><button id="top">真上</button><button id="oblique">斜め</button></div><small id="metrics"></small></section>
</aside><div id="viewport"><div id="overlay">水面は近似表示 / ゲームとの海岸一致は未検証<br>湖・河川・砂浜の自動生成は対象外</div><div id="status" role="status">初期化中…</div></div></main>`;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const viewport = el<HTMLDivElement>('viewport');
let profile: Profile = { ...DEFAULT_PROFILE };
let map: Heightmap = { width:128, height:128, heights:Float32Array.from({length:128*128},(_,i)=>{const x=i%128,y=Math.floor(i/128);return -3+16*Math.exp(-((x-68)**2+(y-64)**2)/850);}) };
let grid: Int16Array;
let history:AsyncHistory;
let historyPaused=false,waitingForDrain=false,memoryHistory=false;
let historyFault:{putDelayMs?:number;readDelayMs?:number;failPut?:boolean;failRead?:boolean}={};
let revisionSerial=0,revisions=[0],savedRevision=0;
const revision=()=>revisions[history?.getState().undoCount??0];
const hasUnsavedChanges=()=>revision()!==savedRevision;
const readBudget=(key:string,allowed:number[],fallback:number)=>{try{const value=Number(localStorage.getItem(key));return allowed.includes(value)?value:fallback;}catch{return fallback;}};
let ramBudgetMiB=readBudget('simu-history-ram-mib',[16,64,256],64),diskBudgetMiB=readBudget('simu-history-disk-mib',[128,512,1024],512);
let historyOptions:HistoryOptions={ramBudgetBytes:ramBudgetMiB*1048576,diskBudgetBytes:diskBudgetMiB*1048576,maxEntries:1000};
let busy = false;
const clone = (m: Heightmap): Heightmap => ({width:m.width,height:m.height,heights:m.heights.slice()});
const status = (text:string,error=false) => { el('status').textContent=text;el('status').classList.toggle('error',error); };
const scene = new THREE.Scene(); scene.background = new THREE.Color('#263c43');
const camera = new THREE.PerspectiveCamera(45,1,1,2000);
let renderer: THREE.WebGLRenderer;
try { renderer = new THREE.WebGLRenderer({antialias:true}); }
catch(error) { status(`WebGL2を初期化できません。ブラウザのGPU設定を確認してください。\n${String(error)}`,true);document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('button,input,select').forEach(e=>e.disabled=true);throw error; }
renderer.setPixelRatio(Math.min(devicePixelRatio,2));viewport.prepend(renderer.domElement);
const controls = new OrbitControls(camera,renderer.domElement);controls.mouseButtons={LEFT:null as unknown as THREE.MOUSE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.ROTATE};controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.49;
scene.add(new THREE.HemisphereLight(0xe4f2ed,0x364b35,2));const sun=new THREE.DirectionalLight(0xfff4d9,2.5);sun.position.set(-100,200,100);scene.add(sun);
let terrain: THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>|undefined;
let water: THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>|undefined;
const indicator=new THREE.Mesh(new THREE.RingGeometry(.94,1,64),new THREE.MeshBasicMaterial({color:0xffedb3,side:THREE.DoubleSide,depthTest:false,transparent:true,opacity:.9}));indicator.rotation.x=-Math.PI/2;indicator.renderOrder=10;indicator.visible=false;scene.add(indicator);
let geometryBytes=0;
let lastTimings:Record<string,number>={};
let quantization={changed:0,outsideRange:0,fractional:0,reachableMin:-12,reachableMax:32};
function quantizationText(){return `書出時の量子化: ${quantization.changed.toLocaleString()}画素（到達範囲外 ${quantization.outsideRange.toLocaleString()} / 小数 ${quantization.fractional.toLocaleString()}）。到達標高 ${quantization.reachableMin}〜${quantization.reachableMax}。表示は量子化後の結果です。`;}
function historyButtons(){
 if(!history)return;
 const state=history.getState();
 el<HTMLButtonElement>('undo').disabled=busy||state.reading||state.undoCount===0;
 el<HTMLButtonElement>('redo').disabled=busy||state.reading||state.redoCount===0;
 if(waitingForDrain&&!busy&&!state.reading&&!state.failed&&state.queuedBytes===0){historyPaused=false;waitingForDrain=false;status('履歴の退避が完了しました。造成を再開できます');}
 el('historyState').textContent=`${memoryHistory?`RAM履歴（上限 ${((historyOptions.ramBudgetBytes??0)/1048576).toFixed(0)} MiB）`:'IndexedDB履歴'}: Undo ${state.undoCount} / Redo ${state.redoCount}\n退避待ち ${(state.queuedBytes/1048576).toFixed(2)} MiB / ${memoryHistory?'RAM保存':'保存済み'} ${(state.storedBytes/1048576).toFixed(2)} MiB${state.failed?'\n保存失敗: 未退避履歴をRAMに保持しています':''}${state.reading?'\n履歴を読み込み中…':''}${historyPaused?'\n造成は一時停止中':''}`;
 el<HTMLSelectElement>('historyDisk').disabled=busy||state.reading||memoryHistory;
 el<HTMLButtonElement>('historyMemory').hidden=!(state.failed||historyPaused);
}
function makeHistory(options:HistoryOptions=historyOptions,ramOnly=memoryHistory){
 const memory=new Map<string,ArrayBuffer>();
 let backend:HistoryStore;
 try{backend=ramOnly?{put:async(key,buffer)=>{memory.set(key,buffer);},get:async key=>memory.get(key)?.slice(0),delete:async keys=>{for(const key of keys)memory.delete(key);},dispose:async()=>{memory.clear();}}:new BrowserHistoryStore();}catch(error){const failure=error instanceof Error?error:new Error(String(error));backend={put:async()=>{throw failure;},get:async()=>{throw failure;},delete:async()=>{},dispose:async()=>{}};}
 const wrapped:HistoryStore={
  put:async(key,buffer)=>{const fault=ramOnly?{}:{...historyFault};if(fault.putDelayMs)await new Promise(r=>setTimeout(r,fault.putDelayMs));if(fault.failPut)throw new Error('Injected history storage failure');await backend.put(key,buffer);},
  get:async key=>{const fault=ramOnly?{}:{...historyFault};if(fault.readDelayMs)await new Promise(r=>setTimeout(r,fault.readDelayMs));if(fault.failRead)throw new Error('Injected history read failure');return backend.get(key);},
  delete:keys=>backend.delete(keys),dispose:()=>backend.dispose()
 };
 const instance=new AsyncHistory(wrapped,{...options,...(ramOnly?{diskBudgetBytes:options.ramBudgetBytes}:{}),onChange:()=>{if(history===instance)historyButtons();},onError:error=>{
  if(history!==instance)return;
  historyPaused=true;waitingForDrain=false;
  if(gesture)finishGesture(true);
  status(`履歴保存に失敗しました。地形と未退避履歴は保持しています。画像を書き出すか、確認後に履歴を破棄／RAMのみへ切り替えてください。\n${String(error)}`,true);historyButtons();
 }});
 return instance;
}
function historyFailure(error:unknown){
 historyPaused=true;waitingForDrain=error instanceof HistoryBudgetError&&error.reason==='ram'&&error.requiredBytes<=(historyOptions.ramBudgetBytes??0)&&history.getState().queuedBytes>0&&!history.getState().failed;
 status(`造成を反映できませんでした。地形と履歴は変更前へ戻しました。${waitingForDrain?'履歴の退避完了を待っています。':'画像を書き出すか、履歴予算の変更／履歴破棄を確認してください。'}\n${String(error)}`,true);historyButtons();
}
function resetHistory(){history.reset();historyPaused=false;waitingForDrain=false;revisions=[++revisionSerial];historyButtons();}
function rememberRevision(){const count=history.getState().undoCount;revisions=revisions.slice(0,count);revisions.push(++revisionSerial);}
function editingBlocked(){return busy||historyPaused||history.getState().reading||history.getState().failed;}
history=makeHistory();historyButtons();
input('historyRam').value=String(ramBudgetMiB);input('historyDisk').value=String(diskBudgetMiB);
type Edit={incremental:boolean;bounds:DirtyBounds|null};
function rebuild(next=map,nextProfile=profile,edit?:Edit){
 const start=performance.now();
 const w=next.width,h=next.height;
 const patch=edit?.incremental&&edit.bounds&&nextProfile===profile&&w===map.width&&h===map.height?patchGrid(grid,next,edit.bounds):null;
 const nextGrid=patch?patch.grid:toGrid(next,nextProfile);const gridDone=performance.now();
 const nextQuantization=patch?{changed:0,outsideRange:0,fractional:0,reachableMin:decodeSample(0,nextProfile),reachableMax:decodeSample(255,nextProfile)}:quantizationReport(next,nextProfile);
 // Validate water allocation before mutating the visible terrain buffers.
 const nextWater=patch&&water&&!waterChanged(grid,nextGrid,w,h,nextProfile.seaLevel,patch.dirty)?water:createWaterMesh(nextGrid,w,h,nextProfile.seaLevel);const waterDone=performance.now();
 let geometry:THREE.BufferGeometry;
 try{geometry=terrainGeometry(nextGrid,w,h,nextProfile.seaLevel,terrain?.geometry,grid,profile.seaLevel,patch?.dirty);}
 catch(error){if(nextWater!==water){nextWater.geometry.dispose();nextWater.material.dispose();}throw error;}
 if(terrain&&terrain.geometry!==geometry){scene.remove(terrain);terrain.geometry.dispose();terrain.material.dispose();terrain=undefined;}
 if(!terrain){terrain=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1}));scene.add(terrain);}
 if(water&&water!==nextWater){scene.remove(water);water.geometry.dispose();water.material.dispose();}
 water=nextWater;scene.add(water);map=next;profile=nextProfile;grid=nextGrid;quantization=nextQuantization;el('quantization').textContent=quantizationText();el('quantization').classList.toggle('warning',quantization.outsideRange>0);
 geometryBytes=geometry.getIndex()!.array.byteLength+Object.values(geometry.attributes).reduce((sum,attribute)=>sum+attribute.array.byteLength,0)+Object.values(nextWater.geometry.attributes).reduce((sum,attribute)=>sum+attribute.array.byteLength,0);
 el('metrics').textContent=`${w} × ${h}タイル / ${(w+1)} × ${(h+1)}頂点\n${(w*h*2).toLocaleString()}三角形 / メッシュ ${(geometryBytes/1048576).toFixed(1)} MiB（CPU配列のみ）`;
 lastTimings={...lastTimings,gridMs:gridDone-start,quantizationAndWaterMs:waterDone-gridDone,geometryMs:performance.now()-waterDone,rebuildMs:performance.now()-start};
 historyButtons();
}
function view(top=false){const size=Math.max(8,map.width,map.height);controls.target.set(0,0,0);camera.position.set(top?0:size*.7,top?size*1.4:size*.85,top?.001:size*.85);camera.near=Math.max(.5,size/1000);camera.far=Math.max(200,size*6);camera.updateProjectionMatrix();controls.update();}
function setMap(next:Heightmap){if(history.getState().reading||gesture)throw new Error('履歴読込・造成中は地図を置き換えられません');validateDimensions(next.width,next.height);if(next.heights.length!==next.width*next.height||!next.heights.every(Number.isFinite))throw new Error('画像寸法または標高データが不正です');rebuild(clone(next));resetHistory();view();}
type Stroke = Parameters<typeof applyBrush>[2];
function stroke(options:Stroke){
 if(editingBlocked())throw new Error('History is busy, paused or unavailable');
 const previous=map;const coreStart=performance.now();const result=applyBrushIncremental(map,profile,options);lastTimings={coreMs:performance.now()-coreStart};
 if(result.changed){
  const patch=createPatch(previous,result.map,result.changedIndices)!;
  rebuild(result.map,profile,result);
  try{history.record(patch);rememberRevision();}catch(error){rebuild(previous);historyFailure(error);throw error;}
 }
 status(`造成完了: ${result.changed.toLocaleString()}画素変更 / 履歴 ${history.getState().undoCount}回（非同期保存）`);
}
function selectedStroke(x:number,y:number):Stroke{return{x,y,radius:Number(input('radius').value),amount:Number(input('amount').value),tool:el<HTMLSelectElement>('tool').value as Stroke['tool']};}
function setBusy(value:boolean){busy=value;document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('button,input,select').forEach(e=>e.disabled=value);historyButtons();}
el('create').addEventListener('click',()=>{
 try{
  const width=Number(input('newWidth').value),height=Number(input('newHeight').value);
  try{validateDimensions(width,height);}catch{throw new Error('幅・高さは1〜4,096の整数、合計16,777,216タイル以下で指定してください');}
  if(!confirm('現在の地形とUndo/Redo履歴を置き換えて新規作成しますか？'))return;
  setMap({width,height,heights:new Float32Array(width*height)});
  indicator.visible=false;el('dragHeight').textContent='開始点で決定';
  status(`${width} × ${height}タイルの平坦な地形を新規作成しました`);
 }catch(error){status(String(error),true);}
});
input('file').addEventListener('change',async()=>{const file=input('file').files?.[0];if(!file)return;setBusy(true);status('画像を読み込んでいます…');try{const next=await importHeightmap(file,profile);if(!confirm('現在の地形とUndo/Redo履歴を置き換えてマップを開きますか？'))return;setMap(next);savedRevision=revision();status(`${file.name} を読み込みました`);}catch(error){status(String(error),true);}finally{setBusy(false);input('file').value='';}});
el('export').addEventListener('click',()=>{try{const bytes=exportBmp(map,profile);const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'image/bmp'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='simutrans-heightmap.bmp';anchor.click();savedRevision=revision();setTimeout(()=>URL.revokeObjectURL(url),10000);status(`BMPを書き出しました。${quantizationText()} 互換設定を合わせて確認してください。`);}catch(error){status(String(error),true);}});
async function moveHistory(redo=false){
 if(busy||history.getState().reading)return;
 setBusy(true);status('履歴を読み込み中…');
 try{const moved=await (redo?history.redo(map,next=>rebuild(next)):history.undo(map,next=>rebuild(next)));if(moved)status(redo?'造成をやり直しました':'造成を元に戻しました');}
 catch(error){status(`履歴を復元できませんでした。地形と履歴位置を保持しています。\n${String(error)}`,true);}
 finally{setBusy(false);}
}
el('undo').addEventListener('click',()=>void moveHistory());el('redo').addEventListener('click',()=>void moveHistory(true));
el('historyDiscard').addEventListener('click',()=>{if(!confirm('現在の地形は保持し、Undo/Redo履歴をすべて破棄して続行しますか？'))return;const wasDirty=hasUnsavedChanges();resetHistory();if(!wasDirty)savedRevision=revision();status('履歴を破棄しました。現在の地形は保持しています');});
el('historyMemory').addEventListener('click',()=>{
 if(!confirm('現在の履歴を破棄し、ブラウザ保存を使わずRAMのみで履歴を保持して続行しますか？'))return;
 const old=history,wasDirty=hasUnsavedChanges();memoryHistory=true;history=makeHistory();historyPaused=false;waitingForDrain=false;revisions=[++revisionSerial];if(!wasDirty)savedRevision=revision();void old.dispose().catch(()=>{});historyButtons();status('RAMのみの履歴へ切り替えました。現在の地形は保持しています');
});
for(const id of ['historyRam','historyDisk'])el(id).addEventListener('change',()=>{
 const ram=Number(input('historyRam').value),disk=Number(input('historyDisk').value);
 if(!confirm('履歴予算を変更すると現在のUndo/Redo履歴を破棄します。地形を保持して続行しますか？')){input('historyRam').value=String(ramBudgetMiB);input('historyDisk').value=String(diskBudgetMiB);return;}
 const old=history,wasDirty=hasUnsavedChanges();ramBudgetMiB=ram;diskBudgetMiB=disk;historyOptions={...historyOptions,ramBudgetBytes:ram*1048576,diskBudgetBytes:disk*1048576};
 history=makeHistory();historyPaused=false;waitingForDrain=false;revisions=[++revisionSerial];if(!wasDirty)savedRevision=revision();void old.dispose().catch(()=>{});
 try{localStorage.setItem('simu-history-ram-mib',String(ram));localStorage.setItem('simu-history-disk-mib',String(disk));}catch{/* Settings persistence is optional. */}
 historyButtons();status('履歴予算を更新しました');
});
window.addEventListener('beforeunload',event=>{if(hasUnsavedChanges()){event.preventDefault();event.returnValue='';}});
for(const id of ['mode','factor','maxSlope','seaLevel']){input(id).value=String(profile[id as keyof Profile]);el(id).addEventListener('change',()=>{const previous=profile;try{const sea=Number(input('seaLevel').value);if(!Number.isFinite(sea)||sea<-12||sea>32)throw new Error('海面は−12〜32で指定してください');const nextProfile:Profile={...profile,mode:el<HTMLSelectElement>('mode').value as Profile['mode'],factor:Number(input('factor').value) as 1|2,maxSlope:Number(input('maxSlope').value) as 1|2,seaLevel:sea};if((history.getState().undoCount||history.getState().redoCount||history.getState().queuedBytes)&&!confirm('互換設定を変更するとUndo/Redo履歴を破棄します。現在の標高を保持して続行しますか？')){input(id).value=String(previous[id as keyof Profile]);return;}rebuild(map,nextProfile);resetHistory();status('互換設定を更新しました（編集標高は維持）');}catch(error){profile=previous;input(id).value=String(profile[id as keyof Profile]);status(String(error),true);}});}
input('radius').addEventListener('input',()=>{el('radiusValue').textContent=input('radius').value;indicator.scale.setScalar(Number(input('radius').value));});el('top').addEventListener('click',()=>view(true));el('oblique').addEventListener('click',()=>view());
const raycaster=new THREE.Raycaster();
const pointer=new THREE.Vector2();
type Point={x:number;y:number};
type Gesture={id:number;before:Heightmap;last:Point|null;options:Stroke;changed:Set<number>};
let gesture:Gesture|null=null;
let pendingPointers:{clientX:number;clientY:number}[]=[];
let paintFrame=0;
function pick(event:{clientX:number;clientY:number}){
 if(!terrain)return null;
 const rect=renderer.domElement.getBoundingClientRect();
 pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
 raycaster.setFromCamera(pointer,camera);
 return intersectTerrain(raycaster.ray,grid,map.width,map.height);
}
let pendingEdit:Edit|null=null;
function paintPointer(event:{clientX:number;clientY:number},candidate=map):Heightmap{
 const point=pick(event);
 indicator.visible=!!point&&(!busy||!!gesture);
 if(!point){if(gesture)gesture.last=null;return candidate;}
 indicator.position.copy(point);indicator.position.y+=.2;indicator.scale.setScalar(Number(input('radius').value));
 if(!gesture)return candidate;
 const at={x:point.x+map.width/2,y:point.z+map.height/2};
 const result=applyBrushIncremental(candidate,profile,{...gesture.options,...at,from:gesture.last??undefined});
 if(result.changed){
  for(const index of result.changedIndices)gesture.changed.add(index);
  if(!pendingEdit)pendingEdit={incremental:result.incremental,bounds:result.bounds?{...result.bounds}:null};
  else{
   pendingEdit.incremental&&=result.incremental;
   const a=pendingEdit.bounds,b=result.bounds;
   if(a&&b){a.x0=Math.min(a.x0,b.x0);a.y0=Math.min(a.y0,b.y0);a.x1=Math.max(a.x1,b.x1);a.y1=Math.max(a.y1,b.y1);}
   else pendingEdit.bounds=null;
  }
 }
 gesture.last=at;
 return result.changed?result.map:candidate;
}
function flushPointers(){
 cancelAnimationFrame(paintFrame);paintFrame=0;const pending=pendingPointers;pendingPointers=[];
 pendingEdit=null;let next=map;for(const point of pending)next=paintPointer(point,next);
 if(next!==map)rebuild(next,profile,pendingEdit??undefined);
}
function finishGesture(cancel=false){
 if(!gesture)return;
 const completed=gesture;gesture=null;
 cancelAnimationFrame(paintFrame);paintFrame=0;pendingPointers=[];
 try{
  if(cancel){rebuild(completed.before);status('ドラッグ造成を取り消しました');}
  else {
   const patch=createPatch(completed.before,map,completed.changed);
   if(patch){history.record(patch);rememberRevision();}
   status(`造成完了: ${(patch?.indices.length??0).toLocaleString()}画素変更 / 固定標高 ${(completed.options.target??0)+1} / 履歴 ${history.getState().undoCount}回（非同期保存）`);
  }
 }catch(error){rebuild(completed.before);historyFailure(error);}
 finally{controls.enabled=true;setBusy(false);if(renderer.domElement.hasPointerCapture(completed.id))renderer.domElement.releasePointerCapture(completed.id);}
}
renderer.domElement.addEventListener('pointerdown',event=>{
 if(event.button!==0||gesture)return;
 if(editingBlocked()){status('履歴の保存・読込待ち、又は保存失敗のため造成を一時停止しています。画像を書き出すか、履歴欄を確認してください。',true);return;}
 const point=pick(event);if(!point)return;
 event.preventDefault();
 cancelAnimationFrame(paintFrame);paintFrame=0;pendingPointers=[];
 const at={x:point.x+map.width/2,y:point.z+map.height/2};
 const options=selectedStroke(at.x,at.y),height=Math.round(point.y)-1;
 const delta=options.tool==='raise'?Math.round(options.amount):options.tool==='lower'?-Math.round(options.amount):0;
 options.target=Math.max(decodeSample(0,profile),Math.min(decodeSample(255,profile),height+delta));
 el('dragHeight').textContent=String(options.target+1);
 gesture={id:event.pointerId,before:map,last:null,options,changed:new Set<number>()};
 controls.enabled=false;setBusy(true);renderer.domElement.setPointerCapture(event.pointerId);
 try{pendingEdit=null;const next=paintPointer(event);if(next!==map)rebuild(next,profile,pendingEdit??undefined);status(`ドラッグ造成中: 表示標高 ${options.target+1} に固定（離すと1操作として確定）`);}
 catch(error){finishGesture(true);status(String(error),true);}
});
renderer.domElement.addEventListener('pointermove',event=>{
 if(busy&&!gesture)return;
 if(gesture&&event.pointerId!==gesture.id)return;
 const coalesced=event.getCoalescedEvents?.()??[];
 const points=(coalesced.length?coalesced:[event]).map(point=>({clientX:point.clientX,clientY:point.clientY}));
 if(gesture)pendingPointers.push(...points);else pendingPointers=points.slice(-1);
 if(!paintFrame)paintFrame=requestAnimationFrame(()=>{
  try{flushPointers();}catch(error){finishGesture(true);status(String(error),true);}
 });
});
renderer.domElement.addEventListener('pointerup',event=>{
 if(!gesture||event.pointerId!==gesture.id||event.button!==0)return;
 pendingPointers.push({clientX:event.clientX,clientY:event.clientY});
 try{flushPointers();finishGesture();}catch(error){finishGesture(true);status(String(error),true);}
});
renderer.domElement.addEventListener('pointercancel',event=>{if(gesture?.id===event.pointerId)finishGesture(true);});
renderer.domElement.addEventListener('lostpointercapture',event=>{if(gesture?.id===event.pointerId)finishGesture(true);});
renderer.domElement.addEventListener('pointerleave',()=>{indicator.visible=false;});
window.addEventListener('blur',()=>finishGesture(true));
window.addEventListener('keydown',event=>{if(event.key==='Escape')finishGesture(true);});
new ResizeObserver(()=>{const width=viewport.clientWidth,height=viewport.clientHeight;renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();}).observe(viewport);
function animate(){requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);}rebuild();view();animate();status('検証用の丘と海を表示しています。左ドラッグで高さをそろえて造成できます。');
if(new URLSearchParams(location.search).has('validate')){const gl=renderer.getContext();const debug=gl.getExtension('WEBGL_debug_renderer_info');Object.assign(window,{__validation:{getHistoryState:()=>({...history.getState(),paused:historyPaused,memoryOnly:memoryHistory,dirty:hasUnsavedChanges()}),waitHistory:()=>history.settled(),setHistoryFault:(fault:typeof historyFault)=>{historyFault={...fault};},configureHistory:(options:HistoryOptions)=>{if(history.getState().reading||gesture)throw new Error('History is busy');const old=history;historyOptions={...historyOptions,...options};memoryHistory=false;history=makeHistory();historyPaused=false;waitingForDrain=false;revisions=[++revisionSerial];void old.dispose().catch(()=>{});historyButtons();},getTimings:()=>({...lastTimings}),projectSample:(x:number,y:number)=>{camera.updateMatrixWorld();const xi=Math.max(0,Math.min(map.width,Math.round(x))),yi=Math.max(0,Math.min(map.height,Math.round(y)));const v=new THREE.Vector3(x-map.width/2,grid[xi+yi*(map.width+1)],y-map.height/2).project(camera);const r=renderer.domElement.getBoundingClientRect();return{x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};},getSnapshot:()=>({width:map.width,height:map.height,heights:Array.from(map.heights),grid:Array.from(grid),profile:{...profile},undoCount:history.getState().undoCount,redoCount:history.getState().redoCount}),setMap,stroke,getMetrics:()=>({triangles:map.width*map.height*2,geometryBytes,waterTriangles:water?(water.geometry.getIndex()?.count??water.geometry.getAttribute('position').count)/3:0,drawCalls:renderer.info.render.calls,renderedTriangles:renderer.info.render.triangles,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),webgl2:gl instanceof WebGL2RenderingContext}),renderSample:async(frames=20)=>{const times:number[]=[];for(let i=0;i<frames;i++){await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));const start=performance.now();renderer.render(scene,camera);gl.finish();times.push(performance.now()-start);}times.sort((a,b)=>a-b);return{frameMedianMs:times[Math.floor(times.length*.5)],frameP95Ms:times[Math.min(times.length-1,Math.floor(times.length*.95))]};}}});}
