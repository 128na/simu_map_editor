/** Resource preferences independent of a particular map. */
export interface EditorSettings {maxTiles:number;maxFileMiB:number;displayCells:number;waterMiB:number;maxBrushRadius:number;smoothingRadius:number;smoothingMode:'surface'|'slope'}
export const DEFAULT_EDITOR_SETTINGS:Readonly<EditorSettings>=Object.freeze({maxTiles:67108864,maxFileMiB:256,displayCells:4194304,waterMiB:0,maxBrushRadius:40,smoothingRadius:4,smoothingMode:'surface'});
export const SETTINGS_KEY='simu-map-editor.resources.v1';
export function validateSettings(value:EditorSettings):EditorSettings {
 const ranges:Record<Exclude<keyof EditorSettings,'smoothingMode'>,[number,number]>={maxTiles:[16384,268435456],maxFileMiB:[1,1024],displayCells:[1048576,16777216],waterMiB:[0,256],maxBrushRadius:[1,256],smoothingRadius:[1,16]};
 for(const key of Object.keys(ranges) as (Exclude<keyof EditorSettings,'smoothingMode'>)[]){const [lo,hi]=ranges[key];if(!Number.isInteger(value[key])||value[key]<lo||value[key]>hi)throw new Error('上限設定の値が範囲外です');}
 if(!['surface','slope'].includes(value.smoothingMode))throw new Error('平滑化モードが不正です');
 if(![1048576,2097152,4194304,8388608,16777216].includes(value.displayCells)||![0,16,32,64,128,256].includes(value.waterMiB))throw new Error('表示予算は選択肢から指定してください');
 return {...Object.fromEntries((Object.keys(ranges) as (Exclude<keyof EditorSettings,'smoothingMode'>)[]).map(key=>[key,value[key]])),smoothingMode:value.smoothingMode} as EditorSettings;
}
export function loadEditorSettings(storage?:Pick<Storage,'getItem'>):EditorSettings {
 try{const raw=JSON.parse((storage??globalThis.localStorage).getItem(SETTINGS_KEY)??'null');if(!raw||typeof raw!=='object')return {...DEFAULT_EDITOR_SETTINGS};return validateSettings({...DEFAULT_EDITOR_SETTINGS,...raw});}catch{return {...DEFAULT_EDITOR_SETTINGS};}
}
export function saveEditorSettings(value:EditorSettings,storage?:Pick<Storage,'setItem'>){const settings=validateSettings(value);try{(storage??globalThis.localStorage).setItem(SETTINGS_KEY,JSON.stringify(settings));}catch{/* Optional preference retention. */}}
