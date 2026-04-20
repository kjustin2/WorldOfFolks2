// WorldOfFolks 2 — HTTP + WebSocket Server

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');
const { World } = require('./world');
const { RestartTracker } = require('./restart-tracker');
const {
  parseDescription,
  getMissingFields,
  generateClarifyingQuestions,
  saveProfile,
  loadAllProfiles,
  CHARACTERS_DIR,
} = require('./creator');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const world  = new World();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

// ─── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

// Broadcasts any event log entries logged since `prevEventCount`. Uses the
// monotonic `world.eventCount` rather than `eventLog.length` because the log
// is capped at 200 entries and rotates via shift() — once full, length-based
// deltas always read as zero, silently dropping every live broadcast.
function broadcastNewEvents(prevEventCount) {
  const delta = world.eventCount - prevEventCount;
  if (delta <= 0) return;
  // slice(-delta) handles delta > eventLog.length cleanly (returns the whole
  // log) — we'd lose the very oldest few in that extreme case but action
  // handlers only log a handful of events at a time.
  const newEvents = world.eventLog.slice(-delta);
  for (const ev of newEvents) {
    broadcast({ type: 'event', event: ev });
  }
}

// ─── Core world API ───────────────────────────────────────────────────────────

app.post('/api/register', (req, res) => {
  const { name, role, isPlayer } = req.body;
  if (!name || !role) return res.json({ success: false, error: 'name and role required' });
  const prevCount = world.eventCount;
  const result = world.register(name, role, !!isPlayer);
  // If a human is taking over a character that already has an AI subprocess
  // running, kill it now so the two don't compete for the same character.
  if (isPlayer && result.success && result.agent) {
    killAgentById(result.agent.id, result.agent.name);
  }
  broadcastNewEvents(prevCount);
  broadcast({ type: 'state', state: world.getState() });
  res.json(result);
});

// Actions that only affect the acting agent — we let these through even while
// the world is paused so AI agents can reflect/look around without stalling.
const PASSIVE_ACTIONS = new Set(['look', 'status', 'think', 'remember']);

app.post('/api/action', async (req, res) => {
  const { agentId, action, args = {} } = req.body;
  if (!agentId || !action) return res.json({ success: false, error: 'agentId and action required' });

  // If the player is composing a message, pause outgoing AI actions (move,
  // speak, shout, whisper) by waiting up to 30s for the pause to lift. Keeps
  // NPCs from moving/talking over the player mid-sentence.
  if (!PASSIVE_ACTIONS.has(action) && world.isActionBlocked(agentId)) {
    const deadline = Date.now() + 30_000;
    while (world.isActionBlocked(agentId) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (world.isActionBlocked(agentId)) {
      return res.json({
        success: false,
        paused:  true,
        error:   'The player is composing a message — stay put and try this again in a moment.',
      });
    }
  }

  const prevCount = world.eventCount;
  let result;
  switch (action) {
    case 'look':     result = world.look(agentId); break;
    case 'move':     result = world.move(agentId, args.destination); break;
    case 'speak':    result = world.speak(agentId, args.message); break;
    case 'shout':    result = world.shout(agentId, args.message); break;
    case 'whisper':  result = world.whisper(agentId, args.target, args.message); break;
    case 'think':    result = world.think(agentId, args.thought); break;
    case 'remember': result = world.remember(agentId, args.text); break;
    case 'status':   result = world.look(agentId); break;
    default:
      result = { success: false, error: `Unknown action: ${action}` };
  }

  // If the player was holding the pause and just took a non-passive action,
  // they're done composing — clear the pause now so a dropped /api/pause
  // resume request can't leave the world frozen.
  if (!PASSIVE_ACTIONS.has(action) && world.clearPauseFor(agentId)) {
    broadcast({ type: 'pause', paused: false });
  }

  broadcastNewEvents(prevCount);
  broadcast({ type: 'state', state: world.getState() });
  res.json(result);
});

app.get('/api/world', (req, res) => {
  res.json(world.getState());
});

// Hand a player-controlled character back to AI control. Called when the
// player clicks "Stop playing" or "Play as <someone else>" so the abandoned
// character doesn't disappear from the world — instead an AI takes over.
//
// Steps: flip the world flag → flip the on-disk profile so a future restart
// agrees → reset the supervisor throttle (the player swap shouldn't burn
// through restart attempts) → spawn launch.js --retry <id>.
app.post('/api/player/release', (req, res) => {
  const { agentId } = req.body || {};
  if (!agentId) return res.json({ success: false, error: 'agentId required' });

  const result = world.releaseFromPlayer(agentId);
  if (!result.success) return res.json(result);
  const agent = result.agent;

  // Update the on-disk profile so a future cold restart matches in-memory state.
  try {
    const profiles = loadAllProfiles();
    const profile  = profiles.find(p => p.name === agent.name);
    if (profile) {
      profile.isPlayer = false;
      saveProfile(profile);
    }
  } catch (err) {
    console.warn('[release] failed to update profile:', err.message);
  }

  // Make sure /api/game/status surfaces this agent during its cold-start.
  const existing = expectedAIAgents.find(a => a.id === agentId);
  if (existing) existing.spawnedAt = Date.now();
  else expectedAIAgents.push({
    id: agentId, name: agent.name, role: agent.role, spawnedAt: Date.now(),
  });

  // A swap shouldn't count against the supervisor's restart budget.
  supervisorRestarts.reset(agentId);

  // Clear any stale PID file from a prior life so the spawn check is clean.
  const pidFile = path.join(ROOT, 'characters', '.pids', `${agentId}.pid`);
  try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch {}

  console.log(`[release] Spawning AI for ${agent.name}`);
  const launcher = spawn('node', ['launch.js', '--retry', agentId], {
    cwd:   ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   { ...process.env, MANAGED: 'true' },
  });
  launcher.stdout.on('data', d => process.stdout.write(d));
  launcher.stderr.on('data', d => process.stderr.write(d));

  broadcast({ type: 'state', state: world.getState() });
  res.json({ success: true });
});

app.post('/api/deregister', (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.json({ success: false, error: 'agentId required' });
  const prevCount = world.eventCount;
  const result = world.deregister(agentId);
  broadcastNewEvents(prevCount);
  broadcast({ type: 'state', state: world.getState() });
  res.json(result);
});

// Pause/resume the world while the player is composing a message.
// Body: { paused: true|false, holderId: <playerId> }
app.post('/api/pause', (req, res) => {
  const { paused, holderId } = req.body || {};
  const result = paused
    ? world.pause(holderId || null)
    : world.resume(holderId || null);
  broadcast({ type: 'pause', paused: !!world.worldPause });
  res.json(result);
});

app.post('/api/reset', (req, res) => {
  const { agentId } = req.body;
  const prevCount = world.eventCount;
  const result = agentId ? world.resetAgent(agentId) : world.resetAll();
  broadcastNewEvents(prevCount);
  broadcast({ type: 'state', state: world.getState() });
  res.json(result);
});

// ─── Setup / Character management API ─────────────────────────────────────────

app.get('/api/setup', (req, res) => {
  const profiles     = loadAllProfiles();
  const activeAgents = Object.values(world.agents).filter(a => a.active);
  res.json({
    needsSetup:   profiles.length === 0,
    characters:   profiles.map(p => ({ name: p.name, role: p.role, isPlayer: !!p.isPlayer, traits: p.traits })),
    agentsRunning: activeAgents.length > 0,
  });
});

app.get('/api/characters', (req, res) => {
  res.json({ success: true, characters: loadAllProfiles() });
});

// Parse a freeform description → structured profile (calls Claude, takes a few seconds)
app.post('/api/setup/parse', (req, res) => {
  const { description, existingProfile } = req.body;
  if (!description) return res.json({ success: false, error: 'description required' });
  try {
    const profile = parseDescription(description, existingProfile || null);
    const missing = getMissingFields(profile);
    let questions = [];
    if (missing.length > 0) {
      try   { questions = generateClarifyingQuestions(profile, missing); }
      catch { questions = missing.map(f => `What is this character's ${f}?`); }
    }
    res.json({ success: true, profile, missing, questions });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Save a character profile to disk
app.post('/api/setup/save', (req, res) => {
  const { profile } = req.body;
  if (!profile || !profile.name) return res.json({ success: false, error: 'profile required' });
  try {
    const filepath = saveProfile(profile);
    res.json({ success: true, filepath });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Delete all character files and reset world
app.delete('/api/characters', (req, res) => {
  try {
    killAgentTerminals();
    if (fs.existsSync(CHARACTERS_DIR)) {
      fs.readdirSync(CHARACTERS_DIR)
        .filter(f => f.endsWith('.json'))
        .forEach(f => fs.unlinkSync(path.join(CHARACTERS_DIR, f)));
    }
    const prevCount = world.eventCount;
    world.resetAll();
    broadcastNewEvents(prevCount);
    broadcast({ type: 'state', state: world.getState() });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Agent lifecycle ──────────────────────────────────────────────────────────

let launchedAgentNames = [];
let agentsLaunched     = false;
// Detailed per-agent expectations from the most recent /api/game/launch.
// Used by /api/game/status so the dashboard can show pending → spawned →
// joined / failed for each AI character instead of one opaque progress bar.
let expectedAIAgents = []; // [{id, name, role, spawnedAt}]

function killAgentTerminals() {
  const PIDS_DIR = path.join(ROOT, 'characters', '.pids');
  const isWin    = process.platform === 'win32';
  const { execSync } = require('child_process');

  // 1. Kill by recorded PID (most reliable — takes out the cmd window too via /T).
  if (fs.existsSync(PIDS_DIR)) {
    const pidFiles = fs.readdirSync(PIDS_DIR).filter(f => f.endsWith('.pid'));
    if (pidFiles.length) console.log(`[cleanup] Killing ${pidFiles.length} agent process(es)...`);
    for (const f of pidFiles) {
      const full = path.join(PIDS_DIR, f);
      let pid = null;
      try { pid = parseInt(fs.readFileSync(full, 'utf8').trim(), 10); } catch {}
      if (pid) {
        try {
          if (isWin) execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
          else       process.kill(pid, 'SIGTERM');
        } catch {}
      }
      try { fs.unlinkSync(full); } catch {}
    }
  }

  // 2. Belt-and-suspenders: try killing any surviving window by title.
  if (isWin && launchedAgentNames.length) {
    for (const name of launchedAgentNames) {
      const title = `WorldOfFolks2: ${name}`;
      try {
        execSync(`taskkill /F /FI "WINDOWTITLE eq ${title}" /T`, { stdio: 'ignore', shell: true });
      } catch {}
    }
  }

  launchedAgentNames = [];
  agentsLaunched     = false;
  expectedAIAgents   = [];
}

// Kill the AI subprocess (and its terminal window on Windows) for one agent.
// Used when a human takes over an existing AI character so the two don't
// fight over the same character.
function killAgentById(agentId, agentName) {
  const PIDS_DIR = path.join(ROOT, 'characters', '.pids');
  const pidFile  = path.join(PIDS_DIR, `${agentId}.pid`);
  const isWin    = process.platform === 'win32';
  const { execSync } = require('child_process');

  if (fs.existsSync(pidFile)) {
    let pid = null;
    try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch {}
    if (pid) {
      try {
        if (isWin) execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        else       process.kill(pid, 'SIGTERM');
      } catch {}
    }
    try { fs.unlinkSync(pidFile); } catch {}
  }

  if (isWin && agentName) {
    const title = `WorldOfFolks2: ${agentName}`;
    try {
      execSync(`taskkill /F /FI "WINDOWTITLE eq ${title}" /T`, { stdio: 'ignore', shell: true });
    } catch {}
  }

  launchedAgentNames = launchedAgentNames.filter(n => n !== agentName);
}

// Kill terminals when the server process exits (Ctrl-C or taskkill on the server)
process.on('SIGINT',  () => { killAgentTerminals(); process.exit(0); });
process.on('SIGTERM', () => { killAgentTerminals(); process.exit(0); });
process.on('exit',    ()  =>  killAgentTerminals());

app.post('/api/game/launch', (req, res) => {
  if (agentsLaunched) {
    return res.json({ success: true, launched: 0, message: 'Agents already running' });
  }

  const profiles = loadAllProfiles();
  const aiChars  = profiles.filter(p => !p.isPlayer);
  if (aiChars.length === 0) {
    return res.json({ success: true, launched: 0, message: 'No AI characters to launch' });
  }

  launchedAgentNames = aiChars.map(p => p.name);
  agentsLaunched     = true;
  expectedAIAgents   = aiChars.map(p => ({
    id:        p.name.toLowerCase().replace(/\s+/g, '_'),
    name:      p.name,
    role:      p.role,
    spawnedAt: Date.now(),
  }));

  const launcher = spawn('node', ['launch.js'], {
    cwd:   ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   { ...process.env, MANAGED: 'true' },
  });

  launcher.stdout.on('data', d => process.stdout.write(d));
  launcher.stderr.on('data', d => process.stderr.write(d));
  launcher.on('close', code => {
    if (code !== 0) console.log(`[launcher] exited with code ${code}`);
  });

  res.json({ success: true, launched: aiChars.length });
});

app.post('/api/game/stop', (req, res) => {
  killAgentTerminals();
  expectedAIAgents = [];
  res.json({ success: true });
});

// Per-agent launch status — drives the loading overlay so users see exactly
// which AI agents have spawned, joined, or failed instead of an opaque bar.
//   pending — terminal hasn't written its pid yet (still in startup window)
//   stuck   — pending past the threshold; the spawn likely failed silently
//             (Windows `cmd /c start` can drop a window with no error). The
//             dashboard surfaces a Retry button for this state.
//   spawned — terminal is alive, Claude CLI cold-starting (~30-60s)
//   joined  — agent has registered with the world and is live
//   failed  — pid existed but the process is gone (terminal closed early)
const STUCK_THRESHOLD_MS = 15_000;
app.get('/api/game/status', (req, res) => {
  const PIDS_DIR = path.join(ROOT, 'characters', '.pids');
  const now = Date.now();
  const agents = expectedAIAgents.map(a => {
    const pidFile = path.join(PIDS_DIR, `${a.id}.pid`);
    let pidExists = false;
    let pidAlive  = false;
    if (fs.existsSync(pidFile)) {
      pidExists = true;
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (pid) {
          try { process.kill(pid, 0); pidAlive = true; } catch {}
        }
      } catch {}
    }
    const worldAgent = world.agents[a.id];
    const joined = !!(worldAgent && worldAgent.active);
    const ageMs  = now - a.spawnedAt;
    let status;
    if (joined)         status = 'joined';
    else if (pidAlive)  status = 'spawned';
    else if (pidExists) status = 'failed';
    else if (ageMs > STUCK_THRESHOLD_MS) status = 'stuck';
    else                status = 'pending';
    return { id: a.id, name: a.name, role: a.role, status, ageMs };
  });
  res.json({ agents });
});

// Re-launch a single agent that failed to start (or got stuck during spawn).
app.post('/api/game/retry-agent', (req, res) => {
  const { agentId } = req.body || {};
  if (!agentId) return res.json({ success: false, error: 'agentId required' });

  const expected = expectedAIAgents.find(a => a.id === agentId);
  if (!expected) {
    return res.json({ success: false, error: 'Agent is not in the launch set' });
  }

  // Clear any stale PID file from the previous attempt so the status check
  // returns to "pending" cleanly while the retry comes up.
  const PIDS_DIR = path.join(ROOT, 'characters', '.pids');
  const pidFile  = path.join(PIDS_DIR, `${agentId}.pid`);
  try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch {}

  // Reset the spawn clock so the stuck-threshold doesn't immediately fire.
  expected.spawnedAt = Date.now();

  const launcher = spawn('node', ['launch.js', '--retry', agentId], {
    cwd:   ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   { ...process.env, MANAGED: 'true' },
  });
  launcher.stdout.on('data', d => process.stdout.write(d));
  launcher.stderr.on('data', d => process.stderr.write(d));

  res.json({ success: true });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', state: world.getState() }));
});

setInterval(() => broadcast({ type: 'state', state: world.getState() }), 5000);

// ─── Agent supervisor ─────────────────────────────────────────────────────────
// Two failure modes we watch for on a 10s tick:
//   1. The agent's claude subprocess died (PID file points at a dead PID).
//      Detected by world.checkAgentHealth().
//   2. The subprocess is still alive but the agent hasn't called any action
//      in STALL_THRESHOLD_MS — the Claude session hung, hit a rate limit, or
//      the model decided it was "done". world.getStalledAIAgents() finds these.
// In both cases, attemptRestart() respawns the agent via launch.js --retry,
// throttled by RestartTracker so a permanently-broken agent doesn't loop.

const STALL_THRESHOLD_MS = 120_000;    // 120s with no actions = wedged.
                                       // Generous on purpose — a respawned
                                       // agent's Claude CLI cold-start can
                                       // take 30-60s before the first action.
const supervisorRestarts = new RestartTracker({ windowMs: 5 * 60_000, limit: 3 });

function attemptRestart(agentId, reason) {
  const agent = world.agents[agentId];
  if (!agent) return false;

  if (!supervisorRestarts.attempt(agentId)) {
    console.log(`[supervisor] ${agent.name}: restart limit reached (${reason}) — leaving offline`);
    return false;
  }

  console.log(`[supervisor] Restarting ${agent.name} (${reason})`);
  killAgentById(agentId, agent.name);
  agent.active       = false;
  agent.lastActionAt = Date.now(); // reset clock so we don't immediately re-detect

  const launcher = spawn('node', ['launch.js', '--retry', agentId], {
    cwd:   ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env:   { ...process.env, MANAGED: 'true' },
  });
  launcher.stdout.on('data', d => process.stdout.write(d));
  launcher.stderr.on('data', d => process.stderr.write(d));
  return true;
}

setInterval(() => broadcast({ type: 'state', state: world.getState() }), 5000);

setInterval(() => {
  const prevCount = world.eventCount;
  let changed     = false;

  // 1. Dead processes (PID file points at a dead PID).
  const dropped = world.checkAgentHealth();
  for (const id of dropped) {
    if (attemptRestart(id, 'process died')) changed = true;
  }

  // 2. Stalled (alive but silent for too long).
  for (const a of world.getStalledAIAgents(STALL_THRESHOLD_MS)) {
    a.active = false;
    world._log('disconnect', `${a.name} stalled — attempting restart`, a.id, a.location);
    if (attemptRestart(a.id, 'stalled')) changed = true;
  }

  if (changed || dropped.length) {
    broadcastNewEvents(prevCount);
    broadcast({ type: 'state', state: world.getState() });
  }
}, 10_000);

// ─── Start ────────────────────────────────────────────────────────────────────

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`  Kill the process:  netstat -ano | findstr :${PORT}  then  taskkill /PID <number> /F`);
    console.error(`  Or use another port:  PORT=3001 npm run play  →  http://localhost:3001\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  WorldOfFolks 2 — http://localhost:${PORT}\n`);
});
