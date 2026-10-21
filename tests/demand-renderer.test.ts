import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DemandRenderer} from '../src/demand-renderer.ts';

function harness() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let serial = 0, draws = 0, moving = false;
  const elapsed: number[] = [];
  const renderer = new DemandRenderer({
    update: seconds => { elapsed.push(seconds); return moving; },
    render: () => { draws++; },
    requestFrame: callback => { callbacks.set(++serial, callback); return serial; },
    cancelFrame: id => { callbacks.delete(id); },
  });
  return {
    renderer, callbacks, elapsed,
    get draws() { return draws; },
    move(value: boolean) { moving = value; },
    frame(time: number) { const next = callbacks.entries().next().value; assert.ok(next, 'frame was requested'); callbacks.delete(next[0]); next[1](time); },
  };
}

test('invalidations coalesce and a static scene has no pending animation frame', () => {
  const h = harness();
  h.renderer.invalidate(); h.renderer.invalidate();
  assert.equal(h.callbacks.size, 1);
  h.frame(100); assert.equal(h.draws, 1); assert.equal(h.callbacks.size, 0);
  h.renderer.invalidate(); h.frame(5000);
  assert.equal(h.draws, 2); assert.equal(h.elapsed[1], 1 / 60);
});

test('camera motion continues until settled and elapsed time is bounded', () => {
  const h = harness(); h.move(true); h.renderer.invalidate();
  h.frame(100); h.frame(500); assert.equal(h.draws, 2); assert.equal(h.elapsed[1], .05);
  h.move(false); h.frame(516); assert.equal(h.callbacks.size, 0); assert.equal(h.draws, 2);
});

test('invalidations during updates are retained for a following frame', () => {
  const callbacks: FrameRequestCallback[] = []; let updates = 0, draws = 0;
  const renderer = new DemandRenderer({
    update: () => { if (++updates === 1) renderer.invalidate(); return false; },
    render: () => { draws++; },
    requestFrame: callback => { callbacks.push(callback); return callbacks.length; },
  });
  renderer.invalidate(); callbacks.shift()!(0); assert.equal(callbacks.length, 1);
  callbacks.shift()!(16); assert.equal(draws, 2); assert.equal(callbacks.length, 0);
});

test('suspension cancels motion and resume redraws without accumulating elapsed time', () => {
  const h = harness(); h.move(true); h.renderer.invalidate(); h.frame(100);
  h.renderer.setSuspended(true); h.renderer.invalidate(); assert.equal(h.callbacks.size, 0);
  h.renderer.setSuspended(false); h.frame(9000);
  assert.equal(h.elapsed[1], 1 / 60); assert.equal(h.draws, 2);
  h.renderer.dispose(); h.renderer.invalidate(); h.renderer.setSuspended(false); assert.equal(h.callbacks.size, 0);
});
