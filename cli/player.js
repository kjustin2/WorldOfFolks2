#!/usr/bin/env node
// WorldOfFolks 2 — Player CLI
// Lets a human play as one of the created characters.
// Run: npm run play

const readline = require('readline');
const http     = require('http');
const WebSocket = require('ws');
const fs       = require('fs');
const path     = require('path');

const BASE_URL  = process.env.TOWN_URL || 'http://localhost:3000';
const WS_URL    = BASE_URL.replace('http', 'ws');
const CHARS_DIR = path.join(__dirname, '..', 'characters');

// ─── Colours ──────────────────────────────────────────────────────────────────

const R = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const MAGENTA= '\x1b[35m';
const WHITE  = '\x1b[37m';

function b(t)  { return `${BOLD}${t}${R}`; }
function cy(t) { return `${CYAN}${t}${R}`; }
function gr(t) { return `${GREEN}${t}${R}`; }
function yw(t) { return `${YELLOW}${t}${R}`; }
function rd(t) { return `${RED}${t}${R}`; }
function mg(t) { return `${MAGENTA}${t}${R}`; }
function dm(t) { return `${DIM}${t}${R}`; }

// ─── State ────────────────────────────────────────────────────────────────────

let agentId     = null;
let myName      = null;
let myRole      = null;
let isObserver  = false;
let worldState  = null;
let ws          = null;
let rlInterface = null;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port:     url.port || 3000,
      path:     url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function doAction(type, args) {
  if (!agentId) return { success: false, error: 'Not connected as a character.' };
  return httpRequest('POST', '/api/action', { agentId, action: type, args: args || {} });
}

// ─── Display helpers ──────────────────────────────────────────────────────────

function printDivider() {
  console.log(dm('─'.repeat(52)));
}

function printLocation(result) {
  if (!result || !result.location) return;

  const emoji = getLocationEmoji(result.locationId || result.location);
  console.log(`\n${cy(`${emoji}  ${b(result.location)}`)}`);
  if (result.description) console.log(dm(`   ${result.description}`));

  const chars = (result.charactersHere || []);
  const msgs  = (result.recentMessages || []).slice(-5);

  // Atmosphere line — what's going on right now
  console.log('\n' + buildAtmosphere(chars, msgs.length));

  if (chars.length) {
    const list = chars.map(c => `${b(c.name)} ${dm('('+c.role+')')}`).join(', ');
    console.log(`${b('Here:')} ${list}`);
  }

  if (msgs.length) {
    console.log(`\n${b('Recent:')}`);
    for (const m of msgs) {
      printSpeech(m.speaker, m.text);
    }
  }

  const whisps = result.whispers || [];
  if (whisps.length) {
    console.log(`\n${mg('Private messages for you:')}`);
    for (const w of whisps) {
      console.log(`  ${mg(b(w.from))} ${dm('whispers:')} ${w.text}`);
    }
  }

  const ctx = result.conversationContext;
  if (ctx && ctx.messages && ctx.messages.length) {
    if (ctx.directlyAddressed) {
      console.log(`\n${yw('⚡ Someone called your name. You should respond.')}`);
    } else {
      console.log(`\n${dm('People nearby are talking. You could join in.')}`);
    }
  }
}

function printSpeech(name, text) {
  const isMe = name === myName;
  if (text.startsWith('[SHOUT]')) {
    console.log(`  ${yw(b(name))} ${dm('[shouts]:')} ${text.replace('[SHOUT] ', '')}`);
  } else if (isMe) {
    console.log(`  ${gr(b('You:'))} ${text}`);
  } else {
    console.log(`  ${cy(b(name + ':'))} ${text}`);
  }
}

function buildAtmosphere(chars, recentCount) {
  if (chars.length === 0) {
    if (recentCount > 0) {
      return dm('You are alone now, but the air still feels like someone was just here.');
    }
    return dm('You are alone. It is quiet.');
  }

  const names = chars.map(c => b(c.name));
  let line;
  if (chars.length === 1) {
    line = `${names[0]} is here with you.`;
  } else if (chars.length === 2) {
    line = `${names[0]} and ${names[1]} are here.`;
  } else {
    const last = names.pop();
    line = `${names.join(', ')}, and ${last} are here.`;
  }

  if (recentCount > 1) {
    line += dm(' Voices have been going back and forth.');
  } else if (recentCount === 1) {
    line += dm(' Someone just spoke.');
  }
  return line;
}

function getLocationEmoji(locId) {
  const map = {
    square: '🏛️', tavern: '🍺', market: '🏪',
    park: '🌳', blacksmith: '⚒️', library: '📚', docks: '⚓',
  };
  if (!locId) return '📍';
  const key = locId.toLowerCase().replace(/\s+/g, '_');
  return map[key] || '📍';
}

function printWorldSummary(state) {
  if (!state || !state.agents) return;
  const active = Object.values(state.agents).filter(a => a.active);
  if (!active.length) return;

  console.log(`\n${b('Town at a glance:')}`);
  // Group by location
  const byLoc = {};
  for (const a of active) {
    if (!byLoc[a.location]) byLoc[a.location] = [];
    byLoc[a.location].push(a.name);
  }
  for (const [loc, names] of Object.entries(byLoc)) {
    const locName = state.locations && state.locations[loc]
      ? state.locations[loc].name : loc;
    const emoji = getLocationEmoji(loc);
    console.log(`  ${emoji} ${b(locName)}: ${names.join(', ')}`);
  }
}

function printHelp() {
  console.log(`
${b(cy('─── Commands ────────────────────────────────────────'))}

  ${b('say')} ${yw('<message>')}            Speak to everyone here
  ${b('go')} ${yw('<location>')}            Move to another location
  ${b('whisper')} ${yw('<name> <message>')}  Private message to one person
  ${b('look')}                    See who's here and recent activity
  ${b('status')}                  Show your character info
  ${b('map')}                     Show where everyone is in town
  ${b('help')}                    Show this list

${b(cy('─── Reset commands ──────────────────────────────────'))}

  ${b('/reset')}                  Remove ALL characters and start creation over
  ${b('/reset')} ${yw('<name>')}          Remove one character (then re-create them)
  ${b('/observe')}                Stop playing, switch to observer mode
  ${b('/play')} ${yw('<name>')}           Become a different character

${b(cy('─── Locations ───────────────────────────────────────'))}

  ${cy('square')}     Town Square   — central hub, everyone passes through
  ${cy('tavern')}     Tavern        — social hub, loose tongues
  ${cy('market')}     Market        — deals, debts
  ${cy('park')}       Park          — quiet, good for private talk
  ${cy('blacksmith')} Blacksmith    — loud, few visitors
  ${cy('library')}    Library       — knowledge and old records
  ${cy('docks')}      Docks         — for those who are leaving

${dm('─────────────────────────────────────────────────────')}
`);
}

// ─── WebSocket: live world updates ───────────────────────────────────────────

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    // Silent reconnect
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'state') {
        worldState = msg.state;
      }
      if (msg.type === 'event' && msg.event) {
        const ev = msg.event;
        // Only show speech events involving others at our location
        if (agentId && worldState) {
          const me = worldState.agents && worldState.agents[agentId];
          if (me && ev.locationId === me.location && ev.type === 'speak' && ev.agentId !== agentId) {
            // Someone spoke at my location — print it and prompt to respond
            const speaker = ev.text.split(':')[0].replace('[', '').trim();
            const said    = ev.text.replace(/^[^:]+:\s*"?/, '').replace(/"$/, '');
            process.stdout.write('\r' + ' '.repeat(80) + '\r');
            printSpeech(speaker, said);
            if (rlInterface) rlInterface.prompt(true);
          }
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    setTimeout(connectWebSocket, 3000);
  });

  ws.on('error', () => {
    // reconnect silently
  });
}

// ─── Character picking ────────────────────────────────────────────────────────

function loadProfiles() {
  if (!fs.existsSync(CHARS_DIR)) return [];
  return fs.readdirSync(CHARS_DIR)
    .filter(f => f.endsWith('.json') && f !== 'world_state.json')
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(CHARS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

async function pickCharacter() {
  const profiles = loadProfiles();

  if (profiles.length === 0) {
    console.log(rd('\nNo characters found. Run: npm run create'));
    process.exit(1);
  }

  const playerProfile = profiles.find(p => p.isPlayer);
  if (playerProfile) {
    // Auto-pick if only one player character designated
    return playerProfile;
  }

  // Let user pick
  console.log(`\n${b(cy('Choose a character to play as:'))}\n`);
  profiles.forEach((p, i) => {
    console.log(`  ${cy((i+1) + '.')} ${b(p.name)} — ${p.role}`);
  });
  console.log(`  ${cy((profiles.length + 1) + '.')} ${DIM}Just watch (observer mode)${R}`);
  console.log('');

  return new Promise(resolve => {
    const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    tempRl.question(`${yw('>')} Your choice: `, (answer) => {
      tempRl.close();
      const idx = parseInt(answer.trim()) - 1;
      if (idx >= 0 && idx < profiles.length) {
        resolve(profiles[idx]);
      } else {
        resolve(null); // observer
      }
    });
  });
}

// ─── Command handling ─────────────────────────────────────────────────────────

async function handleCommand(input) {
  const raw     = input.trim();
  if (!raw) return;

  const lower   = raw.toLowerCase();
  const parts   = raw.split(/\s+/);
  const cmd     = parts[0].toLowerCase();
  const rest    = parts.slice(1).join(' ');

  // ── Special / commands ────────────────────────────────────────────────────

  if (cmd === '/reset') {
    const target = parts.slice(1).join(' ').trim();
    if (!target) {
      const result = await httpRequest('POST', '/api/reset', {});
      console.log(gr(`\nAll characters removed from the world.`));
      console.log(dm('Run npm run create to create new characters.'));
    } else {
      const targetId = target.toLowerCase().replace(/\s+/g, '_');
      const result   = await httpRequest('POST', '/api/reset', { agentId: targetId });
      if (result.success) {
        console.log(gr(`\n${result.removed} has been removed.`));
        console.log(dm(`Run npm run create to recreate them.`));
      } else {
        console.log(rd(`\nCouldn't reset "${target}": ${result.error}`));
      }
    }
    return;
  }

  if (cmd === '/observe') {
    isObserver = true;
    agentId    = null;
    myName     = null;
    console.log(`\n${dm('Switched to observer mode.')}`);
    console.log(dm('Dashboard: http://localhost:3000'));
    console.log(dm('Type /play <name> to become a character again.'));
    return;
  }

  if (cmd === '/play') {
    const targetName = parts.slice(1).join(' ').trim();
    if (!targetName) {
      console.log(rd('Usage: /play <character name>'));
      return;
    }
    await becomeCharacter(targetName);
    return;
  }

  if (cmd === 'help') {
    printHelp();
    return;
  }

  // Observer-only mode
  if (isObserver || !agentId) {
    if (cmd === 'map') {
      printWorldSummary(worldState);
    } else {
      console.log(dm('You are in observer mode. Type /play <name> to become a character.'));
      console.log(dm('Dashboard: http://localhost:3000'));
    }
    return;
  }

  // ── In-character commands ─────────────────────────────────────────────────

  if (cmd === 'say' || cmd === 's') {
    if (!rest) { console.log(rd('Usage: say <message>')); return; }
    const result = await doAction('speak', { message: rest });
    if (result.success) {
      printSpeech(myName, rest);
      if (result.conversationContext && result.conversationContext.messages.length) {
        // Show who's listening
        const others = (result.conversationContext.othersHere || []);
        if (others.length) {
          console.log(dm(`\n  ${others.join(' and ')} heard you.`));
        }
      }
    } else {
      console.log(rd(result.error));
    }
    return;
  }

  if (cmd === 'go' || cmd === 'move') {
    if (!rest) { console.log(rd('Usage: go <location>  (square|tavern|market|park|blacksmith|library|docks)')); return; }
    const result = await doAction('move', { destination: rest });
    if (result.success) {
      printLocation(result);
    } else {
      console.log(rd(`\n${result.error}`));
    }
    return;
  }

  if (cmd === 'whisper' || cmd === 'w') {
    const targetName = parts[1];
    const message    = parts.slice(2).join(' ');
    if (!targetName || !message) {
      console.log(rd('Usage: whisper <name> <message>'));
      return;
    }
    const result = await doAction('whisper', { target: targetName, message });
    if (result.success) {
      console.log(`  ${mg(`You whispered to ${b(result.to)}:`)} ${message}`);
    } else {
      console.log(rd(`\n${result.error}`));
    }
    return;
  }

  if (cmd === 'look' || cmd === 'l') {
    const result = await doAction('look');
    if (result.success) {
      printLocation(result);
    } else {
      console.log(rd(result.error));
    }
    return;
  }

  if (cmd === 'status') {
    const result = await doAction('status');
    if (result.success) {
      const me = worldState && worldState.agents && worldState.agents[agentId];
      const locName = result.location || (me && me.location) || 'unknown';
      console.log(`\n${b('Your character:')}`);
      console.log(`  Name:     ${b(myName)}`);
      console.log(`  Role:     ${myRole}`);
      console.log(`  Location: ${locName}`);
    } else {
      console.log(rd(result.error));
    }
    return;
  }

  if (cmd === 'map') {
    printWorldSummary(worldState);
    return;
  }

  // If nothing matched, try to say it as speech (quality-of-life: raw text = speak)
  if (raw.length > 2 && !raw.startsWith('/')) {
    const result = await doAction('speak', { message: raw });
    if (result.success) {
      printSpeech(myName, raw);
    } else {
      console.log(rd(result.error));
      console.log(dm('Type help to see available commands.'));
    }
    return;
  }

  console.log(dm(`Unknown command: ${cmd}. Type help for the list.`));
}

// ─── Become a character ───────────────────────────────────────────────────────

async function becomeCharacter(profile) {
  // If passed a string (name), look up profile
  if (typeof profile === 'string') {
    const profiles = loadProfiles();
    const found = profiles.find(p => p.name.toLowerCase() === profile.toLowerCase());
    if (!found) {
      console.log(rd(`\nNo character named "${profile}" found.`));
      return;
    }
    profile = found;
  }

  myName   = profile.name;
  myRole   = profile.role;
  isObserver = false;

  // Register with server (or re-register if already there)
  let result;
  try {
    result = await httpRequest('POST', '/api/register', {
      name:     myName,
      role:     myRole,
      isPlayer: true,
    });
  } catch (err) {
    console.log(rd(`\nCannot reach server at ${BASE_URL}. Start it with: npm start`));
    process.exit(1);
  }

  if (!result.success) {
    console.log(rd(`\nRegistration failed: ${result.error}`));
    return;
  }

  agentId = result.agent.id;

  console.log(`
${cy('╔══════════════════════════════════════════════════╗')}
${cy('║')}   You are now playing as ${b(myName)}${' '.repeat(Math.max(0, 24 - myName.length))}${cy('║')}
${cy('╚══════════════════════════════════════════════════╝')}
`);
  console.log(`${b('Role:')} ${myRole}`);
  if (profile.traits) {
    const traits = Array.isArray(profile.traits) ? profile.traits.join(', ') : profile.traits;
    console.log(`${b('You are:')} ${traits}`);
  }
  if (profile.wants) console.log(`${b('You want:')} ${profile.wants}`);
  if (profile.flaw)  console.log(`${b('Your flaw:')} ${profile.flaw}`);
  console.log('');
  printHelp();

  // Look on arrival
  const look = await doAction('look');
  if (look.success) printLocation(look);
}

// ─── REPL loop ────────────────────────────────────────────────────────────────

async function startREPL() {
  rlInterface = readline.createInterface({
    input:     process.stdin,
    output:    process.stdout,
    prompt:    `\n${cy('>')} `,
    terminal:  true,
  });

  rlInterface.on('line', async (line) => {
    rlInterface.pause();
    try {
      await handleCommand(line);
    } catch (err) {
      console.log(rd(`Error: ${err.message}`));
    }
    rlInterface.resume();
    rlInterface.prompt();
  });

  rlInterface.on('close', () => {
    console.log(`\n${dm('Goodbye.')}`);
    process.exit(0);
  });

  rlInterface.prompt();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`
${cy('╔══════════════════════════════════════════════════╗')}
${cy('║')}       ${b('WorldOfFolks 2 — Player Mode')}              ${cy('║')}
${cy('╚══════════════════════════════════════════════════╝')}
`);

  // Pick character
  const chosen = await pickCharacter();

  connectWebSocket();

  if (chosen) {
    await becomeCharacter(chosen);
  } else {
    isObserver = true;
    console.log(`\n${dm('Observer mode. You can watch the town unfold.')}`);
    console.log(dm('Dashboard: http://localhost:3000'));
    console.log(dm('Type /play <name> to become a character.'));
    console.log(dm('Type map to see where everyone is.'));
    console.log('');
  }

  await startREPL();
}

main().catch(err => {
  console.error(rd('\nFatal error: ' + err.message));
  process.exit(1);
});
