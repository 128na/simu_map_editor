import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PREFERENCES, loadPreferences, savePreferences, type Preferences} from '../src/preferences.ts';

const read = (value: unknown) => loadPreferences({getItem: () => JSON.stringify(value)});

test('valid map-independent preferences survive a storage round trip', () => {
  let key = '', serialized = '';
  const preferences: Preferences = {version: 1, tool: 'flatten', radius: 40, amount: 8, view: 'top'};
  savePreferences(preferences, {setItem: (k, value) => {key = k; serialized = value;}});
  assert.deepEqual(loadPreferences({getItem: k => k === key ? serialized : null}), preferences);
  assert.deepEqual(read({version: 1, tool: 'lower', radius: 1, amount: 1, view: 'oblique'}),
    {version: 1, tool: 'lower', radius: 1, amount: 1, view: 'oblique'});
});

test('invalid fields fall back independently without coercing strings or fractional numbers', () => {
  assert.deepEqual(read({version: 1, tool: 'raise', radius: '40', amount: 2, view: 'top'}),
    {...DEFAULT_PREFERENCES, amount: 2, view: 'top'});
  for (const radius of [0, 41, 1.5, null]) assert.equal(read({version: 1, radius}).radius, 8);
  for (const amount of [0, 9, 1.5, '2']) assert.equal(read({version: 1, amount}).amount, 1);
  assert.deepEqual(read({version: 1, tool: 'paint', radius: 3, amount: 4, view: 'side'}),
    {...DEFAULT_PREFERENCES, radius: 3, amount: 4});
});

test('unknown versions and malformed documents reset all settings', () => {
  for (const value of [null, [], 4, {tool: 'lower'}, {version: 2, tool: 'lower', radius: 2}]) {
    assert.deepEqual(read(value), DEFAULT_PREFERENCES);
  }
  assert.deepEqual(loadPreferences({getItem: () => '{bad json'}), DEFAULT_PREFERENCES);
  const defaults = loadPreferences({getItem: () => null});
  defaults.radius = 12;
  assert.equal(DEFAULT_PREFERENCES.radius, 8);
});

test('storage access and quota errors do not escape, including outside a browser', () => {
  assert.deepEqual(loadPreferences({getItem: () => {throw new Error('denied');}}), DEFAULT_PREFERENCES);
  assert.doesNotThrow(() => savePreferences({...DEFAULT_PREFERENCES}, {setItem: () => {throw new Error('quota');}}));
  assert.deepEqual(loadPreferences(), DEFAULT_PREFERENCES);
  assert.doesNotThrow(() => savePreferences({...DEFAULT_PREFERENCES}));
});

test('saving validates inputs and excludes terrain or unrelated properties', () => {
  let serialized = '';
  savePreferences({version: 1, tool: 'lower', radius: -5, amount: 2, view: 'top', seaLevel: 100} as Preferences,
    {setItem: (_key, value) => {serialized = value;}});
  assert.deepEqual(JSON.parse(serialized), {...DEFAULT_PREFERENCES, tool: 'lower', amount: 2, view: 'top'});
});
