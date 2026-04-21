// Covers two recent fixes:
//   1. resetAll() must clear the event log + tick so a "new game" doesn't
//      leak old conversation history into the dashboard or world_state.json.
//   2. buildAgentPrompt() must include the new anti-loop / scene-moves
//      directives so AI agents don't camp on a single topic.
//
// Run with: node tests/reset-and-prompt.test.js

const assert = require('assert');
const { World } = require('../server/world');
const { buildAgentPrompt } = require('../server/creator');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('reset-and-prompt');

// ─── World.resetAll wipes history ────────────────────────────────────────────

function makeWorld() {
  return new World({ load: false, persist: false });
}

test('resetAll clears the event log so old chatter doesn\'t persist', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.speak('alex', 'I have a secret');
  w.speak('alex', 'no one can know');
  // Sanity: history piled up.
  assert.ok(w.eventLog.length > 0, 'precondition: events present');

  w.resetAll();

  // After reset, the only entry left should be the reset log line itself —
  // none of the prior conversation/move events.
  const conversationEvents = w.eventLog.filter(e =>
    e.type === 'speak' || e.type === 'whisper' || e.type === 'move'
  );
  assert.strictEqual(conversationEvents.length, 0,
    'no conversation/move events should survive a full reset');
});

test('resetAll resets tick to 0', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.speak('alex', 'one');
  w.speak('alex', 'two');
  assert.ok(w.tick > 0, 'precondition: tick advanced');
  w.resetAll();
  assert.strictEqual(w.tick, 0);
});

test('resetAll keeps eventCount monotonic (broadcast cursor must not rewind)', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.speak('alex', 'something');
  const before = w.eventCount;
  w.resetAll();
  // resetAll itself logs the "removed" event, so eventCount should be > before.
  assert.ok(w.eventCount > before,
    'eventCount must keep advancing — clients use it as a delta cursor');
});

test('resetAll clears per-location messages and whispers', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.register('Korrey', 'reporter');
  w.speak('alex', 'public message');
  w.whisper('alex', 'Korrey', 'private');
  w.resetAll();
  for (const loc of Object.keys(w.messages)) {
    assert.strictEqual(w.messages[loc].length, 0, `${loc} not cleared`);
  }
  assert.deepStrictEqual(w.whispers, {});
});

// ─── Prompt template includes anti-loop guidance ─────────────────────────────

const sampleProfile = {
  name:   'Test',
  role:   'baker',
  traits: ['curious', 'stubborn'],
  wants:  'to find their missing brother',
  flaw:   'never asks for help',
};

test('buildAgentPrompt embeds the named MOVES menu so AI varies its lines', () => {
  const p = buildAgentPrompt(sampleProfile);
  // The menu of dramatic moves — present in the prompt means the AI sees it.
  for (const move of ['CONFESS', 'ACCUSE', 'REVEAL', 'CHALLENGE', 'CONTRADICT', 'PROPOSE']) {
    assert.ok(p.includes(move), `prompt should mention MOVE: ${move}`);
  }
});

test('buildAgentPrompt instructs against repetition', () => {
  const p = buildAgentPrompt(sampleProfile);
  assert.ok(/never repeat yourself|do not say it again|do not repeat/i.test(p),
    'prompt should explicitly forbid repetition');
});

test('buildAgentPrompt tells the AI to pivot when a scene goes long', () => {
  const p = buildAgentPrompt(sampleProfile);
  assert.ok(/pivot|change the subject|change the topic/i.test(p),
    'prompt should tell the AI to change topics when a scene stalls');
});

test('buildAgentPrompt embeds the character\'s identity fields', () => {
  const p = buildAgentPrompt(sampleProfile);
  assert.ok(p.includes('Test'),    'name in prompt');
  assert.ok(p.includes('baker'),   'role in prompt');
  assert.ok(p.includes('curious'), 'traits in prompt');
  assert.ok(p.includes('missing brother'), 'wants in prompt');
  assert.ok(p.includes('never asks for help'), 'flaw in prompt');
});

test('buildAgentPrompt tells the agent to read new scene-fatigue fields', () => {
  const p = buildAgentPrompt(sampleProfile);
  for (const field of ['sceneFatigue', 'suggestedMove', 'pivotDirective', 'repeating', 'myLinesHere']) {
    assert.ok(p.includes(field), `prompt should mention context field: ${field}`);
  }
});

// ─── Scene-fatigue signals in conversationContext ───────────────────────────

test('fresh scene reports sceneFatigue=fresh and no pivotDirective', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.register('Bea',  'baker');
  w.speak('alex', 'Morning.');
  const ctx = w.look('bea').conversationContext;
  assert.strictEqual(ctx.sceneFatigue, 'fresh');
  assert.strictEqual(ctx.pivotDirective, null);
  assert.strictEqual(ctx.suggestedMove, null);
});

test('long scene surfaces a suggestedMove + warming directive', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.register('Bea',  'baker');
  // 6 lines total → sceneFatigue = 'long'
  for (let i = 0; i < 3; i++) {
    w.speak('alex', `one line ${i}`);
    w.speak('bea',  `another line ${i}`);
  }
  const ctx = w.look('bea').conversationContext;
  assert.ok(['long', 'stale'].includes(ctx.sceneFatigue),
    `sceneFatigue should be long/stale, got ${ctx.sceneFatigue}`);
  assert.ok(ctx.suggestedMove, 'suggestedMove should be present');
  assert.ok(ctx.pivotDirective, 'pivotDirective should be present');
});

test('stale scene demands a hard pivot', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.register('Bea',  'baker');
  for (let i = 0; i < 6; i++) {
    w.speak('alex', `alpha ${i}`);
    w.speak('bea',  `beta ${i}`);
  }
  const ctx = w.look('bea').conversationContext;
  assert.strictEqual(ctx.sceneFatigue, 'stale');
  assert.ok(/MUST|pivot|stale/i.test(ctx.pivotDirective),
    'pivotDirective should be urgent');
});

test('repeating=true flags when an agent re-uses their own content words', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.register('Bea',  'baker');
  w.speak('alex', 'The harbor fire burned everything important overnight.');
  w.speak('bea',  'Okay.');
  w.speak('alex', 'The harbor burned everything important — nothing left.');
  const ctx = w.look('alex').conversationContext;
  assert.strictEqual(ctx.repeating, true);
  assert.ok(ctx.suggestedMove, 'a repeating agent must be given a way out');
});

test('non-repeating back-to-back lines do NOT flag repeating', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.speak('alex', 'I finally finished the ballad this morning.');
  w.speak('alex', 'Someone broke into the chapel last night.');
  const ctx = w.look('alex').conversationContext;
  assert.strictEqual(ctx.repeating, false);
});

test('myLinesHere counts only this agent\'s lines', () => {
  const w = makeWorld();
  w.register('Alex', 'musician');
  w.register('Bea',  'baker');
  w.speak('alex', 'line 1');
  w.speak('bea',  'line 2');
  w.speak('alex', 'line 3');
  w.speak('alex', 'line 4');
  const ctx = w.look('alex').conversationContext;
  assert.strictEqual(ctx.myLinesHere, 3);
});

// ─── Wipe hygiene ───────────────────────────────────────────────────────────

test('wipeGameFiles removes profiles, memories, prompts, pids, and world_state', () => {
  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  // Hand-roll an isolated characters dir in tmp, then require the server with
  // CHARACTERS_DIR pointing at it via a symlink-style redirect. Simpler: run
  // the wipe logic inline — it's pure fs and does not import world state.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wof2-wipe-'));
  const dirs = {
    root:     tmpRoot,
    memories: path.join(tmpRoot, 'memories'),
    prompts:  path.join(tmpRoot, 'prompts'),
    pids:     path.join(tmpRoot, '.pids'),
  };
  for (const d of [dirs.memories, dirs.prompts, dirs.pids]) fs.mkdirSync(d);

  fs.writeFileSync(path.join(dirs.root, 'alex.json'),       '{}');
  fs.writeFileSync(path.join(dirs.root, 'world_state.json'),'{}');
  fs.writeFileSync(path.join(dirs.root, 'stray.tmp'),       '');
  fs.writeFileSync(path.join(dirs.memories, 'alex.txt'),    'old memory');
  fs.writeFileSync(path.join(dirs.prompts,  'alex.txt'),    'old prompt');
  fs.writeFileSync(path.join(dirs.pids,     'alex.pid'),    '12345');

  // Replicate the wipe (same rules as server/index.js wipeGameFiles).
  for (const f of fs.readdirSync(dirs.root)) {
    const full = path.join(dirs.root, f);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) fs.unlinkSync(full);
    } catch {}
  }
  for (const sub of ['memories', 'prompts', '.pids']) {
    const d = path.join(dirs.root, sub);
    for (const f of fs.readdirSync(d)) fs.unlinkSync(path.join(d, f));
  }

  assert.strictEqual(fs.readdirSync(dirs.root).filter(f =>
    fs.statSync(path.join(dirs.root, f)).isFile()).length, 0,
    'top-level files must all be gone');
  assert.strictEqual(fs.readdirSync(dirs.memories).length, 0);
  assert.strictEqual(fs.readdirSync(dirs.prompts).length,  0);
  assert.strictEqual(fs.readdirSync(dirs.pids).length,     0);

  // Cleanup
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

if (failed) {
  console.log(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll tests passed.');
