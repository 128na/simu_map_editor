import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_EDITOR_SETTINGS,loadEditorSettings,saveEditorSettings,validateSettings} from '../src/editor-settings.ts';
test('resource settings roundtrip, exclude unrelated data and reject unsupported budgets',()=>{
 let data='';const value={...DEFAULT_EDITOR_SETTINGS,maxTiles:268435456,maxFileMiB:512,waterMiB:128,maxBrushRadius:80,smoothingRadius:8};
 saveEditorSettings(value,{setItem:(_,v)=>{data=v;}});assert.deepEqual(loadEditorSettings({getItem:()=>data}),value);
 const withMap={...value,heights:[1,2],seaLevel:20};saveEditorSettings(withMap,{setItem:(_,v)=>{data=v;}});assert.equal(JSON.parse(data).heights,undefined);assert.equal(JSON.parse(data).seaLevel,undefined);
 for(const bad of [{maxTiles:1},{maxFileMiB:1025},{displayCells:1048577},{waterMiB:257},{maxBrushRadius:0},{smoothingRadius:17},{smoothingMode:'invalid' as any}])assert.throws(()=>validateSettings({...value,...bad}));
});
test('resource storage failure and corrupt settings fall back without blocking editing',()=>{
 for(const raw of ['oops','null','{"maxTiles":-1}','{"displayCells":123}'])assert.deepEqual(loadEditorSettings({getItem:()=>raw}),DEFAULT_EDITOR_SETTINGS);
 assert.deepEqual(loadEditorSettings({getItem:()=>{throw new Error('denied');}}),DEFAULT_EDITOR_SETTINGS);
 assert.doesNotThrow(()=>saveEditorSettings({...DEFAULT_EDITOR_SETTINGS},{setItem:()=>{throw new Error('quota');}}));
});
