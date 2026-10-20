import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE_PRESETS,encodingKey,validateEditorProfile} from '../src/compatibility.ts';
import {mapResources,largeMapWarning} from '../src/resources.ts';
test('editor profiles bind to validated bounds and distinguish image encoding from display',()=>{
 for(const preset of PROFILE_PRESETS)validateEditorProfile(preset.profile);
 const p=PROFILE_PRESETS[0].profile;assert.equal(encodingKey(p),encodingKey({...p,seaLevel:0,maxSlope:2}));
 assert.notEqual(encodingKey(p),encodingKey({...p,min:-40}));assert.throws(()=>validateEditorProfile({...p,max:127}));assert.throws(()=>validateEditorProfile({...p,seaLevel:21}));
 validateEditorProfile({...p,min:-127,max:125,maxSlope:2,seaLevel:-40});
});
test('large-map warning and resource budgets distinguish edge and total tiles',()=>{
 assert.equal(largeMapWarning(4096,4096),'');assert.ok(mapResources(4097,1).large);assert.ok(mapResources(8192,8192).workingBytes>1024*1048576);assert.match(largeMapWarning(8192,8192),/4096/);
 assert.throws(()=>mapResources(32767,1));assert.throws(()=>mapResources(8193,8192));
});
