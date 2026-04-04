// WorldOfFolks 2 — Dashboard Frontend

const WS_URL = `ws://${location.host}`;

const LOCATIONS = [
  { id: 'square',     name: 'Town Square', emoji: '🏛️' },
  { id: 'tavern',     name: 'Tavern',      emoji: '🍺' },
  { id: 'market',     name: 'Market',      emoji: '🏪' },
  { id: 'park',       name: 'Park',        emoji: '🌳' },
  { id: 'blacksmith', name: 'Blacksmith',  emoji: '⚒️' },
  { id: 'library',    name: 'Library',     emoji: '📚' },
  { id: 'docks',      name: 'Docks',       emoji: '⚓' },
];

// ─── State ────────────────────────────────────────────────────────────────────

let state = null;
let lastSaid = {}; // agentId -> last spoken message

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus(true);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        state = msg.state;
        render(state);
      }
      if (msg.type === 'event' && msg.event) {
        appendEvent(msg.event);
      }
    } catch {}
  };

  ws.onclose = () => {
    setStatus(false);
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    setStatus(false);
  };
}

function setStatus(connected) {
  const el = document.getElementById('connection-status');
  if (connected) {
    el.textContent = '🟢 connected';
    el.className = 'connected';
  } else {
    el.textContent = '🔴 reconnecting...';
    el.className = 'disconnected';
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function render(state) {
  if (!state) return;

  const agents  = Object.values(state.agents || {}).filter(a => a.active);
  const agentCount = agents.length;

  document.getElementById('agent-count').textContent =
    `${agentCount} character${agentCount !== 1 ? 's' : ''}`;

  renderMap(agents);
  renderCharacters(agents, state);
  renderFeedFromState(state);
}

// ── Map ───────────────────────────────────────────────────────────────────────

function renderMap(agents) {
  const grid = document.getElementById('location-grid');
  grid.innerHTML = '';

  for (const loc of LOCATIONS) {
    const here  = agents.filter(a => a.location === loc.id);
    const card  = document.createElement('div');
    card.className = `location-card${here.length ? ' has-people' : ''}`;

    const header = document.createElement('div');
    header.className = 'loc-header';
    header.innerHTML = `<span class="loc-emoji">${loc.emoji}</span><span class="loc-name">${loc.name}</span>`;

    const people = document.createElement('div');
    people.className = 'loc-people';

    for (const a of here) {
      const dot = document.createElement('span');
      dot.className = `person-dot${a.isPlayer ? ' is-player' : ''}`;
      dot.textContent = a.isPlayer ? `★ ${a.name}` : a.name;
      people.appendChild(dot);
    }

    card.appendChild(header);
    card.appendChild(people);
    grid.appendChild(card);
  }
}

// ── Character cards ───────────────────────────────────────────────────────────

function renderCharacters(agents, state) {
  const list = document.getElementById('character-list');
  list.innerHTML = '';

  if (!agents.length) {
    list.innerHTML = `<div style="color:var(--text-dim);padding:8px;font-size:0.82rem;">
      No characters in town yet.<br>Run <code>npm run launch</code> to start.
    </div>`;
    return;
  }

  // Sort: player first, then by name
  const sorted = [...agents].sort((a, b) => {
    if (a.isPlayer && !b.isPlayer) return -1;
    if (!a.isPlayer && b.isPlayer) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const a of sorted) {
    const card     = document.createElement('div');
    card.className = `character-card${a.isPlayer ? ' is-player' : ''}`;

    const locObj = LOCATIONS.find(l => l.id === a.location);
    const locStr = locObj ? `${locObj.emoji} ${locObj.name}` : a.location;

    const lastMsg = lastSaid[a.id];
    const lastSaidHtml = lastMsg
      ? `<div class="char-last-said">"${escapeHtml(lastMsg)}"</div>`
      : '';

    card.innerHTML = `
      <div class="char-header">
        <span class="char-name${a.isPlayer ? ' is-player' : ''}">${escapeHtml(a.name)}${a.isPlayer ? ' ★' : ''}</span>
        <span class="char-role">${escapeHtml(a.role)}</span>
      </div>
      <div class="char-location">${locStr}</div>
      ${lastSaidHtml}
    `;
    list.appendChild(card);
  }
}

// ── Event feed ────────────────────────────────────────────────────────────────

let feedRendered = false;

function renderFeedFromState(state) {
  if (feedRendered) return; // after first load, only use live events
  const feed = document.getElementById('event-feed');
  feed.innerHTML = '';

  const entries = (state.eventLog || []).slice(-60);
  for (const entry of entries) {
    appendEvent(entry, false);
  }
  feedRendered = true;
  scrollFeedToBottom();
}

function appendEvent(entry, animate = true) {
  const feed = document.getElementById('event-feed');
  const el   = document.createElement('div');
  el.className = `feed-entry ${entry.type || ''}`;
  if (!animate) el.style.animation = 'none';

  const ts = formatTime(entry.ts);

  // Track last said per agent
  if (entry.type === 'speak' && entry.agentId) {
    const match = entry.text.match(/^[^:]+:\s*"?(.+)"?$/);
    if (match) lastSaid[entry.agentId] = match[1].replace(/"$/, '');
  }

  el.innerHTML = buildEntryHTML(entry, ts);
  feed.appendChild(el);

  // Cap feed at 200 entries
  while (feed.children.length > 200) feed.removeChild(feed.firstChild);

  const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 40;
  if (atBottom) scrollFeedToBottom();
}

function buildEntryHTML(entry, ts) {
  const tsHtml = `<span class="ts">${ts}</span>`;

  switch (entry.type) {
    case 'speak': {
      const parts   = entry.text.match(/^([^:]+):\s*"?(.+?)"?$/);
      const speaker = parts ? escapeHtml(parts[1]) : '';
      const said    = parts ? escapeHtml(parts[2]) : escapeHtml(entry.text);
      return `${tsHtml}<span class="speaker">${speaker}</span>: ${said}`;
    }
    case 'shout': {
      const parts   = entry.text.match(/^([^:]+)\s+shouts:\s*"?(.+?)"?$/);
      const speaker = parts ? escapeHtml(parts[1]) : '';
      const said    = parts ? escapeHtml(parts[2]) : escapeHtml(entry.text);
      return `${tsHtml}📢 <span class="speaker">${speaker}</span> shouts: ${said}`;
    }
    case 'move':
      return `${tsHtml}${escapeHtml(entry.text)}`;
    case 'join':
      return `${tsHtml}✦ ${escapeHtml(entry.text)}`;
    case 'leave':
      return `${tsHtml}✧ ${escapeHtml(entry.text)}`;
    case 'think':
      return `${tsHtml}💭 ${escapeHtml(entry.text)}`;
    case 'whisper':
      return `${tsHtml}🤫 ${escapeHtml(entry.text)}`;
    case 'reset':
      return `${tsHtml}⚠️ ${escapeHtml(entry.text)}`;
    default:
      return `${tsHtml}${escapeHtml(entry.text || JSON.stringify(entry))}`;
  }
}

function scrollFeedToBottom() {
  const feed = document.getElementById('event-feed');
  feed.scrollTop = feed.scrollHeight;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Clear feed button ────────────────────────────────────────────────────────

document.getElementById('clear-feed').addEventListener('click', () => {
  document.getElementById('event-feed').innerHTML = '';
  feedRendered = false;
});

// ─── Boot ────────────────────────────────────────────────────────────────────

connect();
