import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEFAULT_PROFILE, toGrid, applyBrush, quantizationReport, validateDimensions, type Heightmap, type Profile } from './terrain';
import { importHeightmap, exportBmp } from './codecs';
import './style.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><div><h1>Simutrans / 地形検証</h1><p>画像 → 標高 → 斜面補正 → 3D表示 → BMP書出の試作</p></div><small>ローカルファイルのみ・バックエンドなし</small></header>
<main><aside>
<section><h2>01　ファイル</h2><label class="file">マップ画像を開く<input id="file" type="file" accept=".bmp,.png,.ppm"></label><button id="export" style="width:100%">BMPを書き出す</button><small id="quantization"></small><small>上限: 1,048,576画素 / 各辺4,096<br>入力エラー時も現在の地形を保持します。</small></section>
<section><h2>02　造成</h2><label>ツール<select id="tool"><option value="raise">盛り上げる</option><option value="lower">掘り下げる</option><option value="flatten">平坦化</option></select></label><label>ブラシ半径 <span id="radiusValue">8</span><input id="radius" type="range" min="1" max="40" value="8"></label><label>強さ<input id="amount" type="number" min="1" max="8" step="1" value="1"></label><label>編集標高（表示は+1）<input id="target" type="number" min="-12" max="32" value="4"></label><div class="row"><button id="undo">元に戻す</button><button id="redo">やり直す</button></div><small>左クリックで1回造成。右ドラッグで回転、ホイールでズーム。補正はブラシ外へ波及します。</small></section>
<section><h2>03　互換設定</h2><label>高さ変換<select id="mode"><option value="linear">Linear</option><option value="clamp">Clamp</option><option value="legacy-small">Legacy small</option><option value="legacy-large">Legacy large</option></select></label><div class="row"><label>高さ係数<select id="factor"><option value="1">1</option><option value="2">2</option></select></label><label>最大斜面<select id="maxSlope"><option value="1">1段</option><option value="2">2段</option></select></label></div><label>海面<input id="seaLevel" type="number" min="-12" max="32" value="0"></label><small>変換範囲: −12〜32<br>設定変更は取り込み済みの編集標高を維持。Undo履歴はリセットします。</small></section>
<section><h2>04　表示</h2><div class="row"><button id="top">真上</button><button id="oblique">斜め</button></div><small id="metrics"></small></section>
</aside><div id="viewport"><div id="overlay">水面は近似表示 / ゲームとの海岸一致は未検証<br>湖・河川・砂浜の自動生成は対象外</div><div id="status" role="status">初期化中…</div></div></main>`;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const viewport = el<HTMLDivElement>('viewport');
let profile: Profile = { ...DEFAULT_PROFILE };
let map: Heightmap = { width:128, height:128, heights:Float32Array.from({length:128*128},(_,i)=>{const x=i%128,y=Math.floor(i/128);return -3+16*Math.exp(-((x-68)**2+(y-64)**2)/850);}) };
let grid: Int16Array;
let undo: Heightmap[] = [], redo: Heightmap[] = [];
let busy = false;
const clone = (m: Heightmap): Heightmap => ({width:m.width,height:m.height,heights:m.heights.slice()});
const status = (text:string,error=false) => { el('status').textContent=text;el('status').classList.toggle('error',error); };
const scene = new THREE.Scene(); scene.background = new THREE.Color('#263c43');
const camera = new THREE.PerspectiveCamera(45,1,.1,20000);
let renderer: THREE.WebGLRenderer;
try { renderer = new THREE.WebGLRenderer({antialias:true}); }
catch(error) { status(`WebGL2を初期化できません。ブラウザのGPU設定を確認してください。\n${String(error)}`,true);document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('button,input,select').forEach(e=>e.disabled=true);throw error; }
renderer.setPixelRatio(Math.min(devicePixelRatio,2));viewport.prepend(renderer.domElement);
const controls = new OrbitControls(camera,renderer.domElement);controls.mouseButtons={LEFT:null as unknown as THREE.MOUSE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.ROTATE};controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.49;
scene.add(new THREE.HemisphereLight(0xe4f2ed,0x364b35,2));const sun=new THREE.DirectionalLight(0xfff4d9,2.5);sun.position.set(-100,200,100);scene.add(sun);
let terrain: THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>|undefined;
let water: THREE.Mesh<THREE.PlaneGeometry,THREE.MeshStandardMaterial>|undefined;
const indicator=new THREE.Mesh(new THREE.RingGeometry(.94,1,64),new THREE.MeshBasicMaterial({color:0xffedb3,side:THREE.DoubleSide,depthTest:false,transparent:true,opacity:.9}));indicator.rotation.x=-Math.PI/2;indicator.renderOrder=10;indicator.visible=false;scene.add(indicator);
let geometryBytes=0;
let quantization={changed:0,outsideRange:0,fractional:0,reachableMin:-12,reachableMax:32};
function quantizationText(){return `書出時の量子化: ${quantization.changed.toLocaleString()}画素（到達範囲外 ${quantization.outsideRange.toLocaleString()} / 小数 ${quantization.fractional.toLocaleString()}）。到達標高 ${quantization.reachableMin}〜${quantization.reachableMax}。表示は量子化後の結果です。`;}
function historyButtons(){el<HTMLButtonElement>('undo').disabled=busy||undo.length===0;el<HTMLButtonElement>('redo').disabled=busy||redo.length===0;}
function rebuild(next=map,nextProfile=profile){
 const nextGrid=toGrid(next,nextProfile);const w=next.width,h=next.height,positions=new Float32Array((w+1)*(h+1)*3),colors=new Float32Array(positions.length),indices=new Uint32Array(w*h*6),color=new THREE.Color();
 for(let y=0;y<=h;y++)for(let x=0;x<=w;x++){const i=y*(w+1)+x,z=nextGrid[i];positions.set([x-w/2,z,y-h/2],i*3);color.setHSL(z<=nextProfile.seaLevel?.13:.29-Math.max(0,z)*.003,z<=nextProfile.seaLevel?.24:.24,z<=nextProfile.seaLevel?.32:.36+Math.max(0,z)*.006);colors.set([color.r,color.g,color.b],i*3);}
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const a=y*(w+1)+x,b=a+1,c=a+w+1,d=c+1;indices.set([a,c,b,b,c,d],(y*w+x)*6);}
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.computeVertexNormals();geometry.computeBoundingSphere();
 const nextTerrain=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1}));
 const nextWater=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshStandardMaterial({color:0x4d9eaf,transparent:true,opacity:.57,roughness:.25,side:THREE.DoubleSide,depthWrite:false}));nextWater.rotation.x=-Math.PI/2;nextWater.position.y=nextProfile.seaLevel+.02;
 if(terrain){scene.remove(terrain);terrain.geometry.dispose();terrain.material.dispose();}if(water){scene.remove(water);water.geometry.dispose();water.material.dispose();}
 terrain=nextTerrain;water=nextWater;scene.add(terrain,water);map=next;profile=nextProfile;grid=nextGrid;quantization=quantizationReport(next,nextProfile);el('quantization').textContent=quantizationText();el('quantization').classList.toggle('warning',quantization.outsideRange>0);
 geometryBytes=positions.byteLength+colors.byteLength+indices.byteLength+(geometry.getAttribute('normal').array.byteLength);
 el('metrics').textContent=`${w} × ${h}タイル / ${(w+1)} × ${(h+1)}頂点\n${(w*h*2).toLocaleString()}三角形 / メッシュ ${(geometryBytes/1048576).toFixed(1)} MiB（CPU配列のみ）`;
 historyButtons();
}
function view(top=false){const size=Math.max(map.width,map.height);controls.target.set(0,0,0);camera.position.set(top?0:size*.7,top?size*1.4:size*.85,top?.001:size*.85);camera.far=Math.max(20000,size*10);camera.updateProjectionMatrix();controls.update();}
function setMap(next:Heightmap){validateDimensions(next.width,next.height);if(next.heights.length!==next.width*next.height||!next.heights.every(Number.isFinite))throw new Error('画像寸法または標高データが不正です');rebuild(clone(next));undo=[];redo=[];historyButtons();view();}
type Stroke = Parameters<typeof applyBrush>[2];
function stroke(options:Stroke){const previous=clone(map);const result=applyBrush(map,profile,options);if(result.changed){rebuild(result.map);undo.push(previous);if(undo.length>20)undo.shift();redo=[];historyButtons();}status(`造成完了: ${result.changed.toLocaleString()}画素変更 / 履歴 ${undo.length}回（最大20回）`);}
function selectedStroke(x:number,y:number):Stroke{return{x,y,radius:Number(input('radius').value),amount:Number(input('amount').value),tool:el<HTMLSelectElement>('tool').value as Stroke['tool'],target:Number(input('target').value)};}
function setBusy(value:boolean){busy=value;document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('button,input,select').forEach(e=>e.disabled=value);historyButtons();}
input('file').addEventListener('change',async()=>{const file=input('file').files?.[0];if(!file)return;setBusy(true);status('画像を読み込んでいます…');try{const next=await importHeightmap(file,profile);setMap(next);status(`${file.name} を読み込みました`);}catch(error){status(String(error),true);}finally{setBusy(false);input('file').value='';}});
el('export').addEventListener('click',()=>{try{const bytes=exportBmp(map,profile);const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'image/bmp'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='simutrans-heightmap.bmp';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status(`BMPを書き出しました。${quantizationText()} 互換設定を合わせて確認してください。`);}catch(error){status(String(error),true);}});
el('undo').addEventListener('click',()=>{const prev=undo.at(-1);if(prev)try{const current=clone(map);rebuild(prev);undo.pop();redo.push(current);historyButtons();status('造成を元に戻しました');}catch(error){status(String(error),true);}});el('redo').addEventListener('click',()=>{const next=redo.at(-1);if(next)try{const current=clone(map);rebuild(next);redo.pop();undo.push(current);historyButtons();status('造成をやり直しました');}catch(error){status(String(error),true);}});
for(const id of ['mode','factor','maxSlope','seaLevel']){input(id).value=String(profile[id as keyof Profile]);el(id).addEventListener('change',()=>{const previous=profile;try{const sea=Number(input('seaLevel').value);if(!Number.isFinite(sea)||sea<-12||sea>32)throw new Error('海面は−12〜32で指定してください');const nextProfile:Profile={...profile,mode:el<HTMLSelectElement>('mode').value as Profile['mode'],factor:Number(input('factor').value) as 1|2,maxSlope:Number(input('maxSlope').value) as 1|2,seaLevel:sea};rebuild(map,nextProfile);undo=[];redo=[];historyButtons();status('互換設定を更新しました（編集標高は維持）');}catch(error){profile=previous;input(id).value=String(profile[id as keyof Profile]);status(String(error),true);}});}
input('radius').addEventListener('input',()=>{el('radiusValue').textContent=input('radius').value;indicator.scale.setScalar(Number(input('radius').value));});el('top').addEventListener('click',()=>view(true));el('oblique').addEventListener('click',()=>view());
const raycaster=new THREE.Raycaster();const pointer=new THREE.Vector2();let down:{x:number,y:number}|null=null;
function pick(event:PointerEvent){if(!terrain)return null;const rect=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);return raycaster.intersectObject(terrain)[0]?.point??null;}
renderer.domElement.addEventListener('pointermove',event=>{const point=pick(event);indicator.visible=!!point&&!busy;if(point){indicator.position.copy(point);indicator.position.y+=.2;indicator.scale.setScalar(Number(input('radius').value));}});renderer.domElement.addEventListener('pointerleave',()=>{indicator.visible=false;});renderer.domElement.addEventListener('pointerdown',event=>{if(event.button===0)down={x:event.clientX,y:event.clientY};});renderer.domElement.addEventListener('pointerup',event=>{if(event.button!==0||busy||!down)return;const distance=Math.hypot(event.clientX-down.x,event.clientY-down.y);down=null;if(distance>5)return;const point=pick(event);if(point)try{stroke(selectedStroke(point.x+map.width/2,point.z+map.height/2));}catch(error){status(String(error),true);}});
new ResizeObserver(()=>{const width=viewport.clientWidth,height=viewport.clientHeight;renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();}).observe(viewport);
function animate(){requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);}rebuild();view();animate();status('検証用の丘と海を表示しています。左クリックで造成できます。');
if(new URLSearchParams(location.search).has('validate')){const gl=renderer.getContext();const debug=gl.getExtension('WEBGL_debug_renderer_info');Object.assign(window,{__validation:{getSnapshot:()=>({width:map.width,height:map.height,heights:Array.from(map.heights),grid:Array.from(grid),profile:{...profile},undoCount:undo.length,redoCount:redo.length}),setMap,stroke,getMetrics:()=>({triangles:map.width*map.height*2,geometryBytes,drawCalls:renderer.info.render.calls,renderedTriangles:renderer.info.render.triangles,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),webgl2:gl instanceof WebGL2RenderingContext}),renderSample:async(frames=20)=>{const times:number[]=[];for(let i=0;i<frames;i++){await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));const start=performance.now();renderer.render(scene,camera);gl.finish();times.push(performance.now()-start);}times.sort((a,b)=>a-b);return{frameMedianMs:times[Math.floor(times.length*.5)],frameP95Ms:times[Math.min(times.length-1,Math.floor(times.length*.95))]};}}});}
