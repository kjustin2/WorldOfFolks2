#!/usr/bin/env node
// WorldOfFolks 2 — Agent CLI
// Used by AI agents (Claude Code subprocesses) to interact with the world.
// Usage: node cli/town.js <command> [...args]

const http = require('http');

const BASE_URL = process.env.TOWN_URL || 'http://localhost:3000';

let _agentId = process.env.AGENT_ID || null;

function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port:     url.port || 3000,
      path:     url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
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

function saveAgentId(id) {
  _agentId = id;
  process.stderr.write(`AGENT_ID=${id}\n`);
}

function getAgentId() {
  return process.env.AGENT_ID || _agentId;
}

async function action(type, args) {
  const agentId = getAgentId();
  if (!agentId) {
    console.log(JSON.stringify({ success: false, error: 'Not registered. Run: node cli/town.js register <name> <role>' }));
    process.exit(1);
  }
  return httpRequest('POST', '/api/action', { agentId, action: type, args: args || {} });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    console.log(`
WorldOfFolks 2 — Agent CLI

SETUP (run first):
  node cli/town.js register <name> <role>
  Then set: export AGENT_ID=<id from output>

ACTIONS:
  node cli/town.js look                        See your location and who's here
  node cli/town.js move <location>             Move to a location
  node cli/town.js speak "<message>"           Say something (heard at your location)
  node cli/town.js shout "<message>"           Shout (heard by everyone in town)
  node cli/town.js whisper <name> "<message>"  Private message to one person
  node cli/town.js think "<thought>"           Internal thought (not spoken)
  node cli/town.js remember "<text>"           Save something to persistent memory

LOCATIONS:
  square | tavern | market | park | blacksmith | library | docks

IMPORTANT:
  - If the result contains "conversationContext" with messages — someone spoke.
    Your next command MUST be "speak" to respond.
  - If "directlyAddressed" is true — someone said your name. Respond immediately.
  - Keep speaks to 1–3 sentences. One idea per turn.
`);
    return;
  }

  const cmd = argv[0];

  try {
    let result;

    switch (cmd) {
      case 'register': {
        const name = argv[1];
        const role = argv.slice(2).join(' ');
        if (!name || !role) {
          console.log(JSON.stringify({ error: 'Usage: register <name> <role>' }));
          return;
        }
        result = await httpRequest('POST', '/api/register', { name, role });
        if (result.success) {
          saveAgentId(result.agent.id);
          console.log(JSON.stringify({
            success: true,
            agentId: result.agent.id,
            message: `Registered as ${name} the ${role}. Set: export AGENT_ID=${result.agent.id}`,
          }));
        } else {
          console.log(JSON.stringify(result));
        }
        return;
      }

      case 'look':
        result = await action('look');
        break;

      case 'status':
        result = await action('status');
        break;

      case 'move':
        result = await action('move', { destination: argv.slice(1).join(' ') });
        break;

      case 'speak':
        result = await action('speak', { message: argv.slice(1).join(' ') });
        break;

      case 'shout':
        result = await action('shout', { message: argv.slice(1).join(' ') });
        break;

      case 'whisper': {
        const target  = argv[1];
        const message = argv.slice(2).join(' ');
        if (!target || !message) {
          console.log(JSON.stringify({ error: 'Usage: whisper <name> "<message>"' }));
          return;
        }
        result = await action('whisper', { target, message });
        break;
      }

      case 'think':
        result = await action('think', { thought: argv.slice(1).join(' ') });
        break;

      case 'remember':
        result = await action('remember', { text: argv.slice(1).join(' ') });
        break;

      case 'world':
        result = await httpRequest('GET', '/api/world');
        break;

      default:
        result = { error: `Unknown command: "${cmd}". Run node cli/town.js --help for usage.` };
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: `Cannot reach server at ${BASE_URL}. Is it running? Start with: npm start`,
    }));
  }
}

main();
