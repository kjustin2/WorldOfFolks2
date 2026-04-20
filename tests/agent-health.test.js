// Tests for the agent supervisor — covers both pieces independently:
//   1. RestartTracker (throttle math, with an injected clock)
//   2. World stall-detection bookkeeping (lastActionAt + getStalledAIAgents)
//
// Run with: node tests/agent-health.test.js

const assert = require('assert');
const { World } = require('../server/world');
const { RestartTracker } = require('../server/restart-tracker');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('agent-health');

// ─── RestartTracker ──────────────────────────────────────────────────────────

test('RestartTracker: first restart is allowed', () => {
  const t = new RestartTracker({ limit: 3, windowMs: 60_000 });
  assert.strictEqual(t.attempt('alex'), true);
  assert.strictEqual(t.countInWindow('alex'), 1);
});

test('RestartTracker: blocks the (limit+1)th attempt inside the window', () => {
  const t = new RestartTracker({ limit: 3, windowMs: 60_000 });
  assert.strictEqual(t.attempt('alex'), true);
  assert.strictEqual(t.attempt('alex'), true);
  assert.strictEqual(t.attempt('alex'), true);
  assert.strictEqual(t.attempt('alex'), false, 'fourth should be denied');
  assert.strictEqual(t.attempt('alex'), false, 'fifth still denied');
  assert.strictEqual(t.countInWindow('alex'), 3);
});

test('RestartTracker: allows a fresh attempt after the window slides past old ones', () => {
  let now = 1_000_000;
  const t = new RestartTracker({ limit: 2, windowMs: 60_000, now: () => now });
  assert.strictEqual(t.attempt('alex'), true);
  assert.strictEqual(t.attempt('alex'), true);
  assert.strictEqual(t.attempt('alex'), false);
  // Slide clock past the window — old attempts age out, a new one is allowed.
  now += 60_001;
  assert.strictEqual(t.attempt('alex'), true);
  assert.strictEqual(t.countInWindow('alex'), 1);
});

test('RestartTracker: agents are tracked independently', () => {
  const t = new RestartTracker({ limit: 1, windowMs: 60_000 });
  assert.strictEqual(t.attempt('alex'), true);
  assert.strictEqual(t.attempt('alex'), false, 'alex limited');
  assert.strictEqual(t.attempt('korrey'), true, 'korrey unaffected');
});

test('RestartTracker: reset clears history for one agent', () => {
  const t = new RestartTracker({ limit: 1, windowMs: 60_000 });
  t.attempt('alex');
  t.attempt('korrey');
  t.reset('alex');
  assert.strictEqual(t.attempt('alex'),   true,  'alex reset');
  assert.strictEqual(t.attempt('korrey'), false, 'korrey untouched');
});

// ─── World stall bookkeeping ─────────────────────────────────────────────────

function makeWorld() {
  return new World({ load: false, persist: false });
}

test('register stamps lastActionAt on a new agent', () => {
  const w = makeWorld();
  const before = Date.now();
  w.register('Alex', 'musician');
  const a = w.agents['alex'];
  assert.ok(a, 'agent registered');
  assert.ok(a.lastActionAt >= before, 'lastActionAt set');
});

test('actions update lastActionAt', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.agents['alex'].lastActionAt = 0; // simulate having been idle
  w.speak('alex', 'hello');
  assert.ok(w.agents['alex'].lastActionAt > 0, 'speak touched lastActionAt');

  w.agents['alex'].lastActionAt = 0;
  w.look('alex');
  assert.ok(w.agents['alex'].lastActionAt > 0, 'look touched lastActionAt');

  w.agents['alex'].lastActionAt = 0;
  w.think('alex', 'hmm');
  assert.ok(w.agents['alex'].lastActionAt > 0, 'think touched lastActionAt');
});

test('getStalledAIAgents flags agents past the threshold', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.register('Korrey', 'newspaperman');

  // Pretend Alex hasn't acted in 2 minutes; Korrey just acted.
  w.agents['alex'].lastActionAt   = Date.now() - 120_000;
  w.agents['korrey'].lastActionAt = Date.now();

  const stalled = w.getStalledAIAgents(90_000);
  assert.strictEqual(stalled.length, 1);
  assert.strictEqual(stalled[0].id, 'alex');
});

test('getStalledAIAgents excludes the player character', () => {
  const w = makeWorld();
  w.register('Justin', 'shopkeeper', /* isPlayer */ true);
  w.agents['justin'].lastActionAt = Date.now() - 120_000;
  assert.strictEqual(w.getStalledAIAgents(90_000).length, 0);
});

test('getStalledAIAgents excludes already-inactive agents', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.agents['alex'].lastActionAt = Date.now() - 120_000;
  w.agents['alex'].active       = false;
  assert.strictEqual(w.getStalledAIAgents(90_000).length, 0);
});

test('re-registering an agent resets lastActionAt (so a restart isn\'t instantly re-flagged)', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.agents['alex'].lastActionAt = Date.now() - 120_000;
  assert.strictEqual(w.getStalledAIAgents(90_000).length, 1, 'precondition: stalled');

  w.register('Alex', 'musician'); // simulate restart re-register
  assert.strictEqual(w.getStalledAIAgents(90_000).length, 0, 'no longer stalled after re-register');
});

// ─── Player release / swap ───────────────────────────────────────────────────

test('releaseFromPlayer flips a player-controlled agent back to AI', () => {
  const w = makeWorld();
  w.register('Justin', 'shopkeeper', /* isPlayer */ true);
  assert.strictEqual(w.agents['justin'].isPlayer, true);
  assert.strictEqual(w.agents['justin'].wasLaunchedAI, false);

  const r = w.releaseFromPlayer('justin');
  assert.strictEqual(r.success, true);
  assert.strictEqual(w.agents['justin'].isPlayer, false);
  assert.strictEqual(w.agents['justin'].wasLaunchedAI, true,
    'wasLaunchedAI flips so checkAgentHealth treats them as a real AI');
});

test('releaseFromPlayer rejects an agent that isn\'t player-controlled', () => {
  const w = makeWorld();
  w.register('Alex', 'musician'); // AI agent
  const r = w.releaseFromPlayer('alex');
  assert.strictEqual(r.success, false);
});

test('releaseFromPlayer rejects an unknown agent', () => {
  const w = makeWorld();
  const r = w.releaseFromPlayer('ghost');
  assert.strictEqual(r.success, false);
});

test('after release the agent is considered stallable like any other AI', () => {
  const w = makeWorld();
  w.register('Justin', 'shopkeeper', true);
  w.releaseFromPlayer('justin');
  // Pretend the AI subprocess never registered and a long time passed.
  w.agents['justin'].lastActionAt = Date.now() - 200_000;
  const stalled = w.getStalledAIAgents(120_000);
  assert.strictEqual(stalled.length, 1);
  assert.strictEqual(stalled[0].id, 'justin');
});

if (failed) {
  console.log(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll tests passed.');
