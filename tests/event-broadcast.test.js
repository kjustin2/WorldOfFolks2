// Regression test for the live-broadcast bug.
//
// Symptom: after the world has logged ~200 events, new player messages stopped
// appearing in the conversation feed live; only a full page reload showed them.
//
// Cause: server/index.js used `world.eventLog.length` as the "previous count"
// for `broadcastNewEvents`. The eventLog is capped at 200 and rotates via
// shift() once full, so length stops growing — and `slice(prevCount)` always
// returns []. Every live event broadcast got silently dropped.
//
// Fix: World now tracks a monotonic `eventCount`. The broadcast layer computes
// the delta from that, slices the tail of eventLog by delta, and emits.
//
// Run with: node tests/event-broadcast.test.js

const assert = require('assert');
const { World } = require('../server/world');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('event-broadcast');

// Re-implementation of server/index.js#broadcastNewEvents — we want to test
// the slicing math itself, independent of express/ws.
function newEventsSince(world, prevEventCount) {
  const delta = world.eventCount - prevEventCount;
  if (delta <= 0) return [];
  return world.eventLog.slice(-delta);
}

test('eventCount starts at zero', () => {
  const w = new World({ load: false, persist: false });
  assert.strictEqual(w.eventCount, 0);
});

test('eventCount increments per _log call', () => {
  const w = new World({ load: false, persist: false });
  w._log('test', 'one');
  w._log('test', 'two');
  w._log('test', 'three');
  assert.strictEqual(w.eventCount, 3);
});

test('newEventsSince returns the new entries below the cap', () => {
  const w = new World({ load: false, persist: false });
  for (let i = 0; i < 50; i++) w._log('warmup', `e${i}`);
  const before = w.eventCount;
  w._log('speak', 'hello');
  w._log('speak', 'world');
  const fresh = newEventsSince(w, before);
  assert.strictEqual(fresh.length, 2);
  assert.strictEqual(fresh[0].text, 'hello');
  assert.strictEqual(fresh[1].text, 'world');
});

test('REGRESSION: new events still broadcast after the 200-entry cap rotates', () => {
  const w = new World({ load: false, persist: false });
  // Fill past the cap so the next push triggers a shift().
  for (let i = 0; i < 250; i++) w._log('warmup', `noise-${i}`);
  assert.strictEqual(w.eventLog.length, 200, 'log should be capped at 200');

  // Simulate a player action: capture prevCount, push the speak event,
  // ask the broadcaster what's new.
  const before = w.eventCount;
  w._log('speak', 'Justin: "hello?"');
  const fresh = newEventsSince(w, before);

  // Bug behavior: fresh.length === 0, the speak never reaches the WS layer.
  // Fixed behavior: fresh contains exactly the new event.
  assert.strictEqual(fresh.length, 1, 'expected 1 new event after cap rotation, got ' + fresh.length);
  assert.strictEqual(fresh[0].type, 'speak');
  assert.strictEqual(fresh[0].text, 'Justin: "hello?"');
});

test('newEventsSince handles many events at once after cap', () => {
  const w = new World({ load: false, persist: false });
  for (let i = 0; i < 250; i++) w._log('warmup', `noise-${i}`);
  const before = w.eventCount;
  for (let i = 0; i < 5; i++) w._log('speak', `msg-${i}`);
  const fresh = newEventsSince(w, before);
  assert.strictEqual(fresh.length, 5);
  assert.strictEqual(fresh[0].text, 'msg-0');
  assert.strictEqual(fresh[4].text, 'msg-4');
});

test('newEventsSince returns [] when nothing new', () => {
  const w = new World({ load: false, persist: false });
  w._log('test', 'a');
  const before = w.eventCount;
  assert.deepStrictEqual(newEventsSince(w, before), []);
});

if (failed) {
  console.log(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll tests passed.');
