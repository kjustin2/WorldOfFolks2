#!/usr/bin/env node
// WorldOfFolks 2 — Agent Launcher
// Reads created characters from characters/*.json and spawns a Claude Code
// agent for each one that is not marked as isPlayer.
// Run: npm run launch

const { spawn, spawnSync } = require('child_process');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const BASE_URL       = process.env.TOWN_URL || 'http://localhost:3000';
const CHARACTERS_DIR = path.join(__dirname, 'characters');
const PROMPTS_DIR    = path.join(__dirname, 'characters', 'prompts');
const PIDS_DIR       = path.join(__dirname, 'characters', '.pids');
const MODEL          = process.env.AGENT_MODEL || 'claude-haiku-4-5-20251001';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadProfiles() {
  if (!fs.existsSync(CHARACTERS_DIR)) return [];
  return fs.readdirSync(CHARACTERS_DIR)
    .filter(f => f.endsWith('.json') && f !== 'world_state.json')
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(CHARACTERS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

function fetchWorldState() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}/api/world`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Launch a single agent in a new terminal window ───────────────────────────

function launchAgent(profile) {
  if (!fs.existsSync(PROMPTS_DIR)) fs.mkdirSync(PROMPTS_DIR, { recursive: true });

  const safeId   = profile.name.toLowerCase().replace(/\s+/g, '_');
  const promptFile = path.join(PROMPTS_DIR, `${safeId}.txt`);

  // Build the full prompt: base prompt + operating instructions
  const cliPath    = path.join(__dirname, 'cli', 'town.js').replace(/\\/g, '/');
  const agentPrompt = (profile.generatedPrompt || '') + `

=== OPERATING INSTRUCTIONS ===

You are running as an autonomous agent. Use your Bash tool to run Node.js commands ONE AT A TIME.

YOUR CLI:
  node "${cliPath}" register "${profile.name}" "${profile.role}"
  export AGENT_ID=<id from output>
  node "${cliPath}" look
  node "${cliPath}" move <location>
  node "${cliPath}" speak "<message>"
  node "${cliPath}" shout "<message>"
  node "${cliPath}" whisper <name> "<message>"
  node "${cliPath}" think "<thought>"
  node "${cliPath}" remember "<text>"

START NOW:
1. Run: node "${cliPath}" register "${profile.name}" "${profile.role}"
2. From the JSON output, find "agentId" and run: export AGENT_ID=<that value>
3. Run: node "${cliPath}" look
4. Begin living. Never stop.

IRON LAW:
- After EVERY command, read the output.
- If output contains "conversationContext" with any messages — your NEXT command MUST be "speak".
- If "directlyAddressed" is true — respond IMMEDIATELY. No exceptions.
- Keep speaking for 4–8 exchanges minimum. Don't let conversations die early.
- After each meaningful exchange, run: node "${cliPath}" remember "<what happened and how you feel>"

STAY PUT:
- Most actions should be "speak", "think", or "remember" — NOT "move".
- Wait at least 5–6 actions between moves. A character who hops around can never be talked to.
- NEVER move while a conversation is active. If someone is talking to you or near you, stay.
- Only move when: (a) you are alone AND have nothing to think/remember, or (b) you have a specific, in-character reason to go somewhere (e.g. "I need to find Ruth" — then head there and STOP).
- If "move" returns an error like "someone is waiting to speak with you" — you MUST stay. Do NOT retry the move. Instead "look" or "speak" or "think".
- After arriving at a new location, run "look", then "speak" or "think" BEFORE you even consider moving again.
`;

  fs.writeFileSync(promptFile, agentPrompt, 'utf8');

  const title      = `WorldOfFolks2: ${profile.name}`;
  const scriptPath = path.resolve(__filename);
  const isWin      = process.platform === 'win32';

  console.log(`🚀 Launching ${profile.name} (${profile.role})...`);

  if (isWin) {
    spawn('cmd', [
      '/c', 'start', `"${title}"`,
      'cmd', '/k', `title ${title} && node "${scriptPath}" --run-agent ${safeId}`,
    ], {
      cwd:      __dirname,
      stdio:    'ignore',
      detached: true,
      shell:    true,
    }).unref();
  } else {
    spawn('bash', ['-c', `node "${scriptPath}" --run-agent ${safeId}`], {
      cwd:      __dirname,
      stdio:    'ignore',
      detached: true,
    }).unref();
  }
}

// ─── Run agent (called in the spawned terminal window) ────────────────────────

function runAgent(safeId) {
  const promptFile = path.join(PROMPTS_DIR, `${safeId}.txt`);
  if (!fs.existsSync(promptFile)) {
    console.error(`No prompt file for ${safeId}`);
    process.exit(1);
  }

  // Record this process's PID so the server's cleanup can kill the whole tree
  // (node + the wrapping cmd window + claude CLI) via `taskkill /T /F`.
  if (!fs.existsSync(PIDS_DIR)) fs.mkdirSync(PIDS_DIR, { recursive: true });
  const pidFile = path.join(PIDS_DIR, `${safeId}.pid`);
  try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}
  const cleanupPid = () => { try { fs.unlinkSync(pidFile); } catch {} };
  process.on('exit',    cleanupPid);
  process.on('SIGINT',  () => { cleanupPid(); process.exit(0); });
  process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });

  const prompt = fs.readFileSync(promptFile, 'utf8');
  const isWin  = process.platform === 'win32';
  const cmd    = isWin ? 'cmd' : 'claude';
  const args   = isWin
    ? ['/c', 'claude', '-p', '--model', MODEL, '--dangerously-skip-permissions']
    : ['-p', '--model', MODEL, '--dangerously-skip-permissions'];

  console.log(`Starting agent: ${safeId} (model: ${MODEL}, pid: ${process.pid})`);

  const result = spawnSync(cmd, args, {
    input:    prompt,
    stdio:   ['pipe', 'inherit', 'inherit'],
    shell:    false,
    encoding: 'utf8',
  });

  if (result.error) {
    console.error(`Agent error: ${result.error.message}`);
  }
  console.log(`Agent ${safeId} finished (exit ${result.status}).`);
  cleanupPid();
  process.exit(result.status || 0);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Sub-process mode: running inside a spawned terminal to drive one agent
  if (process.argv[2] === '--run-agent') {
    runAgent(process.argv[3]);
    return;
  }

  console.log(`
╔═══════════════════════════════════════════════╗
║        WorldOfFolks 2 — Agent Launcher        ║
╚═══════════════════════════════════════════════╝
`);

  const profiles = loadProfiles();
  if (profiles.length === 0) {
    console.error('No characters found. Run: npm run create');
    process.exit(1);
  }

  const aiProfiles = profiles.filter(p => !p.isPlayer);
  const playerProfile = profiles.find(p => p.isPlayer);

  console.log(`Characters loaded: ${profiles.length} total`);
  if (playerProfile) {
    console.log(`  Player character: ${playerProfile.name} (skipping AI spawn)`);
  }
  console.log(`  AI agents to spawn: ${aiProfiles.length}`);
  console.log('');

  if (aiProfiles.length === 0) {
    console.log('No AI agents to spawn. If you want AI characters, re-run: npm run create');
    process.exit(0);
  }

  // Wait for server to be ready
  console.log('Waiting for server to be ready...');
  let ready = false;
  for (let i = 0; i < 20; i++) {
    try {
      await fetchWorldState();
      ready = true;
      break;
    } catch {
      await new Promise(r => setTimeout(r, 1500));
      process.stdout.write('.');
    }
  }
  if (!ready) {
    console.error('\n\nServer not reachable. Start it first: npm start');
    process.exit(1);
  }
  console.log('\nServer ready.');

  // Spawn each AI agent. Only a tiny stagger (300ms) so their Claude CLIs
  // boot in parallel — the wall-clock time is dominated by CLI cold-start,
  // which is ~30-60s per agent. Serialising them at 2s each made launches
  // take much longer than necessary.
  for (const profile of aiProfiles) {
    launchAgent(profile);
    await new Promise(r => setTimeout(r, 300));
  }

  if (!process.env.MANAGED) {
    console.log(`
All agents launched!

To watch what's happening:
  Dashboard  →  http://localhost:3000

To play as ${playerProfile ? playerProfile.name : 'a character'}:
  npm run play
`);
  } else {
    console.log(`All ${aiProfiles.length} agent(s) launched.`);
  }
}

main().catch(err => {
  console.error('Launch error:', err.message);
  process.exit(1);
});
