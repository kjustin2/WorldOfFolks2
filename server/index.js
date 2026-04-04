// WorldOfFolks 2 — HTTP + WebSocket Server

const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const path     = require('path');
const { World } = require('./world');

const PORT = process.env.PORT || 3000;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const world  = new World();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

// ─── REST API ─────────────────────────────────────────────────────────────────

app.post('/api/register', (req, res) => {
  const { name, role, isPlayer } = req.body;
  if (!name || !role) return res.json({ success: false, error: 'name and role required' });
  const result = world.register(name, role, !!isPlayer);
  broadcast({ type: 'event', event: result });
  broadcast({ type: 'state', state: world.getState() });
  res.json(result);
});

app.post('/api/action', (req, res) => {
  const { agentId, action, args = {} } = req.body;
  if (!agentId || !action) return res.json({ success: false, error: 'agentId and action required' });

  let result;
  switch (action) {
    case 'look':    result = world.look(agentId); break;
    case 'move':    result = world.move(agentId, args.destination); break;
    case 'speak':   result = world.speak(agentId, args.message); break;
    case 'shout':   result = world.shout(agentId, args.message); break;
    case 'whisper': result = world.whisper(agentId, args.target, args.message); break;
    case 'think':   result = world.think(agentId, args.thought); break;
    case 'remember':result = world.remember(agentId, args.text); break;
    case 'status':  result = world.look(agentId); break; // alias

    default:
      result = { success: false, error: `Unknown action: ${action}` };
  }

  broadcast({ type: 'state', state: world.getState() });
  res.json(result);
});

app.get('/api/world', (req, res) => {
  res.json(world.getState());
});

app.post('/api/deregister', (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.json({ success: false, error: 'agentId required' });
  const result = world.deregister(agentId);
  broadcast({ type: 'state', state: world.getState() });
  res.json(result);
});

app.post('/api/reset', (req, res) => {
  const { agentId } = req.body;
  let result;
  if (agentId) {
    result = world.resetAgent(agentId);
  } else {
    result = world.resetAll();
  }
  broadcast({ type: 'state', state: world.getState() });
  res.json(result);
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

wss.on('connection', (ws) => {
  // Send full state on connect
  ws.send(JSON.stringify({ type: 'state', state: world.getState() }));
});

// Periodic state push every 5s
setInterval(() => broadcast({ type: 'state', state: world.getState() }), 5000);

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║       WorldOfFolks 2 — Server             ║
╠═══════════════════════════════════════════╣
║  Dashboard  →  http://localhost:${PORT}       ║
║  API        →  http://localhost:${PORT}/api   ║
╚═══════════════════════════════════════════╝
`);
});
