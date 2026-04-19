// WorldOfFolks 2 — Browser App

const WS_URL = `ws://${location.host}`;

const LOCATIONS = [
  { id: 'square',     name: 'Town Square', short: 'Square',    emoji: '🏛️' },
  { id: 'tavern',     name: 'Tavern',      short: 'Tavern',    emoji: '🍺' },
  { id: 'market',     name: 'Market',      short: 'Market',    emoji: '🏪' },
  { id: 'park',       name: 'Park',        short: 'Park',      emoji: '🌳' },
  { id: 'blacksmith', name: 'Blacksmith',  short: 'Smithy',    emoji: '⚒️' },
  { id: 'library',    name: 'Library',     short: 'Library',   emoji: '📚' },
  { id: 'docks',      name: 'Docks',       short: 'Docks',     emoji: '⚓' },
];

// ─── App state ─────────────────────────────────────────────────────────────────

const App = {
  worldState:   null,
  ws:           null,
  playerId:     null,  // agentId of human player
  playerName:   null,
  feedRendered: false,
};

// Setup wizard state
const Setup = {
  totalChars:   3,
  characters:   [],
  currentIndex: 0,
  playerIndex:  null,
  addMode:      false,  // true when adding to an existing cast
};

const lastSaid = {};  // agentId → last spoken text
let launching  = false; // guard against double-launch

// Launch-progress state: tracks which AI agents we're still waiting on.
const LaunchProgress = { pending: null };

// World-pause state: true while the player is composing a message. AI actions
// that affect others (move/speak/shout/whisper) are gated server-side.
let worldPaused = false;

// ─── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const [setupData, worldData] = await Promise.all([
      apiFetch('/api/setup'),
      apiFetch('/api/world').catch(() => null),
    ]);

    connectWS();

    if (setupData.needsSetup) {
      showSetupWizard();
      return;
    }

    showGameUI();

    const activeAgents = worldData
      ? Object.values(worldData.agents || {}).filter(a => a.active)
      : [];

    // Restore player session if agent is still in world as isPlayer
    const playerAgent = activeAgents.find(a => a.isPlayer);
    if (playerAgent) {
      App.playerId   = playerAgent.id;
      App.playerName = playerAgent.name;
      setupPlayerPanel();
    }

    // No agents running but characters exist → show launch prompt
    if (activeAgents.length === 0 && setupData.characters.length > 0) {
      showLaunchPrompt(setupData.characters);
    }

  } catch (err) {
    console.error('Init failed:', err);
    showGameUI();
    connectWS();
  }
}

// ─── UI switching ──────────────────────────────────────────────────────────────

function showSetupWizard() {
  document.getElementById('setup-overlay').classList.remove('hidden');
  document.getElementById('game-ui').classList.add('hidden');
  Setup.characters   = [];
  Setup.currentIndex = 0;
  renderSetupStep('count');
}

function showGameUI() {
  document.getElementById('setup-overlay').classList.add('hidden');
  document.getElementById('game-ui').classList.remove('hidden');
}

// ─── Setup flow ────────────────────────────────────────────────────────────────

function renderSetupStep(step) {
  const body  = document.getElementById('setup-body');
  const label = document.getElementById('setup-step-label');
  body.innerHTML = '';

  // ── Step: how many characters ─────────────────────────────────────────────
  if (step === 'count') {
    label.textContent = '';
    body.innerHTML = `
      <div class="setup-intro">
        <h2>Create your cast</h2>
        <p>Describe 2–8 characters in plain English. They'll live in a small town, talk to each other — and you can step in and play as one of them.</p>
      </div>
      <div class="setup-field">
        <label>How many characters?</label>
        <div class="count-row">
          <button class="count-btn" id="cnt-dec">−</button>
          <span id="cnt-display">3</span>
          <button class="count-btn" id="cnt-inc">+</button>
        </div>
        <div class="count-hint">Recommended 3–5. Min 2, max 8.</div>
      </div>
      <button class="setup-primary-btn" id="start-creating-btn">Start Creating →</button>
    `;
    Setup.totalChars = 3;
    document.getElementById('cnt-dec').onclick = () => {
      Setup.totalChars = Math.max(2, Setup.totalChars - 1);
      document.getElementById('cnt-display').textContent = Setup.totalChars;
    };
    document.getElementById('cnt-inc').onclick = () => {
      Setup.totalChars = Math.min(8, Setup.totalChars + 1);
      document.getElementById('cnt-display').textContent = Setup.totalChars;
    };
    document.getElementById('start-creating-btn').onclick = () => {
      Setup.characters   = [];
      Setup.currentIndex = 0;
      renderSetupStep('create');
    };

  // ── Step: describe + parse each character ─────────────────────────────────
  } else if (step === 'create') {
    const idx   = Setup.currentIndex;
    const total = Setup.totalChars;
    const names = Setup.characters.map(c => c.name).filter(Boolean);

    label.textContent = `Character ${idx + 1} of ${total}`;

    body.innerHTML = `
      <div class="setup-intro">
        <p>Describe this character in your own words — name, what they do in town, personality, what they want, any flaws or secrets. The more you give, the richer they'll be.</p>
        ${names.length ? `<p class="names-so-far">Characters so far: <strong>${escHtml(names.join(', '))}</strong>. You can mention their relationships.</p>` : ''}
      </div>
      <div class="setup-field">
        <textarea id="char-desc" rows="6" placeholder="e.g. Marcus is the town blacksmith, a big gruff man who doesn't say much. He's fiercely loyal to people he respects but harbours guilt over an apprentice's accident three years ago. He drinks more than he should and secretly blames himself."></textarea>
      </div>
      <button class="setup-primary-btn" id="parse-btn">Analyze Character →</button>
      <div id="parse-loading" class="hidden">
        <div class="spinner"></div>
        <span>Reading description… this takes a few seconds.</span>
      </div>
      <div id="parse-result"></div>
    `;

    const parseBtn = document.getElementById('parse-btn');
    parseBtn.onclick = async () => {
      const desc = document.getElementById('char-desc').value.trim();
      if (!desc) return alert('Please describe your character first.');
      await runParse(desc, null, idx);
    };

  // ── Step: choose who to play as ───────────────────────────────────────────
  } else if (step === 'choose') {
    label.textContent = 'Choose your role';

    const charBtns = Setup.characters.map((c, i) => `
      <button class="choose-btn" data-idx="${i}">
        <div class="choose-name">${escHtml(c.name)}</div>
        <div class="choose-role">${escHtml(c.role)}</div>
        ${c.traits ? `<div class="choose-traits">${escHtml(Array.isArray(c.traits) ? c.traits.slice(0, 2).join(', ') : c.traits)}</div>` : ''}
      </button>
    `).join('');

    body.innerHTML = `
      <div class="setup-intro">
        <p>Pick a character to play as. You'll control them directly — everyone else becomes an AI agent living their own life in town.</p>
        <p>Or just watch as the story unfolds without you.</p>
      </div>
      <div id="choose-grid">
        ${charBtns}
        <button class="choose-btn observer" data-idx="-1">
          <div class="choose-name">Just Watch</div>
          <div class="choose-role">Observer mode</div>
          <div class="choose-traits">See it all unfold</div>
        </button>
      </div>
      <div id="choose-confirm" class="hidden">
        <button class="setup-primary-btn" id="launch-btn">Launch the Town →</button>
      </div>
    `;

    document.querySelectorAll('.choose-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.choose-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        Setup.playerIndex = parseInt(btn.dataset.idx);
        document.getElementById('choose-confirm').classList.remove('hidden');
      };
    });

    document.getElementById('launch-btn').onclick = launchGame;

  // ── Step: launching ───────────────────────────────────────────────────────
  } else if (step === 'launching') {
    label.textContent = '';
    body.innerHTML = `
      <div class="setup-launching">
        <div class="spinner large"></div>
        <div class="launching-title">Populating the town…</div>
        <div class="launching-sub">Starting AI agents. This takes a moment.</div>
      </div>
    `;
  }
}

// Parse a description, then show the result in-page
async function runParse(description, existingProfile, charIndex) {
  const loading   = document.getElementById('parse-loading');
  const resultDiv = document.getElementById('parse-result');
  const parseBtn  = document.getElementById('parse-btn');

  if (parseBtn) parseBtn.style.display = 'none';
  loading.classList.remove('hidden');
  resultDiv.innerHTML = '';

  try {
    const data = await apiFetch('/api/setup/parse', 'POST', { description, existingProfile });

    loading.classList.add('hidden');

    if (!data.success) {
      resultDiv.innerHTML = `<div class="parse-error">❌ ${escHtml(data.error)}<br>
        <button class="setup-secondary-btn" onclick="location.reload()">Retry</button></div>`;
      return;
    }

    showParsedProfile(data.profile, data.missing, data.questions, description, charIndex);

  } catch (err) {
    loading.classList.add('hidden');
    resultDiv.innerHTML = `<div class="parse-error">Connection error: ${escHtml(err.message)}</div>`;
    if (parseBtn) parseBtn.style.display = '';
  }
}

function showParsedProfile(profile, missing, questions, originalDesc, charIndex) {
  const resultDiv = document.getElementById('parse-result');

  const profileCard = `
    <div class="profile-card">
      <div class="profile-card-header">
        <span class="profile-name">${escHtml(profile.name || '(unnamed)')}</span>
        <span class="profile-role">${escHtml(profile.role || 'role unknown')}</span>
      </div>
      ${profile.traits     ? `<div class="profile-field"><span class="pf-label">Personality</span> ${escHtml(Array.isArray(profile.traits) ? profile.traits.join(', ') : profile.traits)}</div>` : ''}
      ${profile.wants      ? `<div class="profile-field"><span class="pf-label">Wants</span> ${escHtml(profile.wants)}</div>` : ''}
      ${profile.flaw       ? `<div class="profile-field"><span class="pf-label">Flaw</span> ${escHtml(profile.flaw)}</div>` : ''}
      ${profile.backstory  ? `<div class="profile-field"><span class="pf-label">Backstory</span> ${escHtml(profile.backstory)}</div>` : ''}
      ${profile.secret     ? `<div class="profile-field"><span class="pf-label">Secret</span> ${escHtml(profile.secret)}</div>` : ''}
    </div>
  `;

  if (missing.length > 0 && questions.length > 0) {
    // Need more info — show clarifying questions
    const qHtml = questions.map((q, i) => `
      <div class="clarify-q">
        <label>${escHtml(q)}</label>
        <input type="text" class="clarify-input" id="cq-${i}" placeholder="Your answer…">
      </div>
    `).join('');

    resultDiv.innerHTML = `
      ${profileCard}
      <div class="clarify-section">
        <div class="clarify-title">A few things are still unclear — quick answers will help:</div>
        ${qHtml}
        <div class="clarify-actions">
          <button class="setup-primary-btn" id="clarify-submit-btn">Update →</button>
          <button class="setup-secondary-btn" id="redo-btn">Start this character over</button>
        </div>
      </div>
    `;

    document.getElementById('clarify-submit-btn').onclick = async () => {
      const answers = questions.map((q, i) => {
        const a = (document.getElementById(`cq-${i}`) || {}).value?.trim();
        return a ? `Q: ${q}\nA: ${a}` : null;
      }).filter(Boolean);

      if (answers.length === 0) {
        await confirmCharacter(profile, charIndex);
        return;
      }

      const combined = `Original description: ${originalDesc}\n\nFollow-up Q&A:\n${answers.join('\n\n')}`;
      const loading  = document.getElementById('parse-loading');
      resultDiv.innerHTML = '';
      loading.classList.remove('hidden');

      try {
        const data = await apiFetch('/api/setup/parse', 'POST', { description: combined, existingProfile: profile });
        loading.classList.add('hidden');
        if (data.success) {
          showParsedProfile(data.profile, data.missing, data.questions, combined, charIndex);
        } else {
          resultDiv.innerHTML = `<div class="parse-error">${escHtml(data.error)}</div>`;
        }
      } catch (err) {
        loading.classList.add('hidden');
        resultDiv.innerHTML = `<div class="parse-error">${escHtml(err.message)}</div>`;
      }
    };

    document.getElementById('redo-btn').onclick = () => renderSetupStep('create');

  } else {
    // Profile complete
    const isLast      = (charIndex + 1) >= Setup.totalChars;
    const finishLabel = Setup.addMode
      ? 'Save and return to the welcome screen →'
      : 'All done, choose who to play →';
    resultDiv.innerHTML = `
      ${profileCard}
      <div class="confirm-row">
        <button class="setup-primary-btn" id="confirm-btn">
          ${isLast ? finishLabel : 'Looks good, next character →'}
        </button>
        <button class="setup-secondary-btn" id="redo-btn">Describe differently</button>
      </div>
    `;

    document.getElementById('confirm-btn').onclick = () => confirmCharacter(profile, charIndex);
    document.getElementById('redo-btn').onclick   = () => renderSetupStep('create');
  }
}

async function confirmCharacter(profile, charIndex) {
  try {
    const data = await apiFetch('/api/setup/save', 'POST', { profile });
    if (!data.success) { alert('Failed to save: ' + data.error); return; }
  } catch (err) { alert('Save error: ' + err.message); return; }

  Setup.characters.push(profile);
  Setup.currentIndex++;

  if (Setup.currentIndex < Setup.totalChars) {
    renderSetupStep('create');
    return;
  }

  if (Setup.addMode) {
    // Added to an existing cast — go back to the welcome-back screen so the
    // user can pick who to play and launch (now includes the new characters).
    Setup.addMode      = false;
    Setup.characters   = [];
    Setup.currentIndex = 0;
    await returnToWelcomeBack();
    return;
  }

  renderSetupStep('choose');
}

// Add-more flow: user has an existing cast and wants to create more without
// wiping. Runs the standard 'create' step Setup.totalChars times, then returns
// to the welcome-back screen (no player-pick step — player is already chosen
// or can be chosen from the welcome-back screen).
function startAddFlow(currentCount) {
  const MAX_CAST  = 8;
  const remaining = MAX_CAST - currentCount;
  if (remaining <= 0) {
    alert(`Cast is already at the maximum of ${MAX_CAST} characters.`);
    return;
  }

  document.getElementById('setup-step-label').textContent = 'Add characters';
  document.getElementById('setup-body').innerHTML = `
    <div class="setup-intro">
      <h2>Add to the cast</h2>
      <p>You currently have ${currentCount} character${currentCount === 1 ? '' : 's'}. You can have up to ${MAX_CAST}.</p>
    </div>
    <div class="setup-field">
      <label>How many to add?</label>
      <div class="count-row">
        <button class="count-btn" id="cnt-dec">−</button>
        <span id="cnt-display">1</span>
        <button class="count-btn" id="cnt-inc">+</button>
      </div>
      <div class="count-hint">Min 1, max ${remaining}.</div>
    </div>
    <div class="welcome-secondary">
      <button class="setup-primary-btn" id="start-adding-btn">Start Creating →</button>
      <button class="setup-secondary-btn" id="cancel-add-btn">Cancel</button>
    </div>
  `;

  let count = 1;
  document.getElementById('cnt-dec').onclick = () => {
    count = Math.max(1, count - 1);
    document.getElementById('cnt-display').textContent = count;
  };
  document.getElementById('cnt-inc').onclick = () => {
    count = Math.min(remaining, count + 1);
    document.getElementById('cnt-display').textContent = count;
  };
  document.getElementById('cancel-add-btn').onclick = () => returnToWelcomeBack();
  document.getElementById('start-adding-btn').onclick = () => {
    Setup.totalChars   = count;
    Setup.characters   = [];
    Setup.currentIndex = 0;
    Setup.addMode      = true;
    renderSetupStep('create');
  };
}

// Refresh /api/setup and render the welcome-back prompt. Used when returning
// from the add-more flow — avoids reconnecting the websocket.
async function returnToWelcomeBack() {
  try {
    const data = await apiFetch('/api/setup');
    showLaunchPrompt(data.characters || []);
  } catch (err) {
    console.error('returnToWelcomeBack failed:', err);
  }
}

// Show return-visitor launch prompt (characters already exist, no agents running)
function showLaunchPrompt(characters) {
  document.getElementById('setup-overlay').classList.remove('hidden');
  document.getElementById('setup-step-label').textContent = 'Welcome back';

  const charBtns = characters.map((c, i) => `
    <button class="choose-btn" data-name="${escHtml(c.name)}" data-role="${escHtml(c.role)}" data-idx="${i}">
      <div class="choose-name">${escHtml(c.name)}</div>
      <div class="choose-role">${escHtml(c.role)}</div>
    </button>
  `).join('');

  document.getElementById('setup-body').innerHTML = `
    <div class="setup-intro">
      <h2>Town is ready to open</h2>
      <p>Who would you like to play as?</p>
    </div>
    <div id="choose-grid">
      ${charBtns}
      <button class="choose-btn observer" data-idx="-1" data-name="" data-role="">
        <div class="choose-name">Just Watch</div>
        <div class="choose-role">Observer mode</div>
      </button>
    </div>
    <div id="choose-confirm" class="hidden">
      <button class="setup-primary-btn" id="launch-existing-btn">Launch the Town →</button>
    </div>
    <div class="welcome-secondary">
      <button class="setup-secondary-btn" id="add-more-btn">+ Add more characters</button>
      <button class="setup-secondary-btn" id="wipe-all-btn">Start fresh (wipe all)</button>
    </div>
  `;

  let selectedName = null;
  let selectedRole = null;

  document.querySelectorAll('.choose-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.choose-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedName = btn.dataset.name || null;
      selectedRole = btn.dataset.role || null;
      document.getElementById('choose-confirm').classList.remove('hidden');
    };
  });

  document.getElementById('add-more-btn').onclick = () => startAddFlow(characters.length);

  document.getElementById('wipe-all-btn').onclick = async () => {
    if (!confirm('Wipe ALL characters and start a new cast? This cannot be undone.')) return;
    const btn = document.getElementById('wipe-all-btn');
    btn.disabled = true;
    btn.textContent = 'Wiping…';
    try {
      await apiFetch('/api/game/stop', 'POST');     // close any lingering agent terminals
      await apiFetch('/api/characters', 'DELETE');  // delete character files + reset world
      App.playerId     = null;
      App.playerName   = null;
      App.feedRendered = false;
      Object.keys(lastSaid).forEach(k => delete lastSaid[k]);
      showSetupWizard();
    } catch (err) {
      alert('Error: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Start fresh (wipe all)';
    }
  };

  document.getElementById('launch-existing-btn').onclick = async () => {
    await doLaunch({ selectedName, selectedRole, allCharacters: characters });
  };
}

// ─── Unified launch flow ──────────────────────────────────────────────────────
// Used by both the welcome-back prompt and the fresh-setup wizard. Handles:
//   1. Persisting the correct isPlayer flag across all character files, so
//      launch.js does NOT spawn an AI agent for whoever the player picked.
//   2. Registering the player up-front so they exist immediately.
//   3. Kicking off /api/game/launch and showing progress as AI agents register.

async function doLaunch({ selectedName, selectedRole, allCharacters }) {
  if (launching) return;
  launching = true;

  try {
    // 1. Set isPlayer flag on every profile on disk to match the current pick.
    //    This prevents launch.js from spawning an AI for the human-controlled
    //    character, and clears stale isPlayer flags from a previous session.
    try {
      const all = await apiFetch('/api/characters');
      if (all && all.success && Array.isArray(all.characters)) {
        for (const profile of all.characters) {
          const shouldBePlayer = !!(selectedName && profile.name === selectedName);
          if (!!profile.isPlayer !== shouldBePlayer) {
            await apiFetch('/api/setup/save', 'POST', {
              profile: { ...profile, isPlayer: shouldBePlayer },
            });
          }
        }
      }
    } catch (err) {
      console.warn('isPlayer sync failed:', err);
    }

    // 2. Figure out which AI agents we're waiting on (by derived agent id).
    const expectedIds = allCharacters
      .filter(c => c.name !== selectedName)
      .map(c => c.name.toLowerCase().replace(/\s+/g, '_'));
    showLaunchingOverlay(expectedIds);

    // 3. Register the player first so the UI has them immediately.
    if (selectedName) {
      try {
        const data = await apiFetch('/api/register', 'POST', {
          name: selectedName, role: selectedRole, isPlayer: true,
        });
        if (data.success) {
          App.playerId   = data.agent.id;
          App.playerName = selectedName;
        }
      } catch {}
    }

    // 4. Ask the server to spawn AI agent terminals.
    let launchedCount = expectedIds.length;
    try {
      const r = await apiFetch('/api/game/launch', 'POST');
      if (r && typeof r.launched === 'number') launchedCount = r.launched;
    } catch {}

    // 5. Wait for their join events. If the server said "already running"
    //    (launched === 0 despite expected agents), don't hang — just proceed.
    if (launchedCount === 0 && expectedIds.length > 0) {
      console.log('Agents already running — skipping wait.');
    } else {
      await waitForAgentsToJoin(expectedIds.length, 300_000);
    }

  } finally {
    launching = false;
    hideLaunchingOverlay();
    document.getElementById('setup-overlay').classList.add('hidden');
    showGameUI();
    if (App.playerId) setupPlayerPanel();
  }
}

function showLaunchingOverlay(expectedIds) {
  LaunchProgress.pending = {
    expectedIds: new Set(expectedIds),
    joined:      new Set(),
    resolver:    null,
    timer:       null,
  };
  document.getElementById('setup-overlay').classList.remove('hidden');
  renderLaunchingOverlay();
}

function renderLaunchingOverlay() {
  const p = LaunchProgress.pending;
  if (!p) return;
  const label = document.getElementById('setup-step-label');
  const body  = document.getElementById('setup-body');
  if (!body) return;
  if (label) label.textContent = 'Waking up the town';

  const done   = p.joined.size;
  const total  = p.expectedIds.size;
  const ratio  = total > 0 ? Math.min(1, done / total) : 1;
  const pct    = Math.round(ratio * 100);
  const status = total === 0
    ? 'No AI agents to wait for — opening town…'
    : (done >= total
        ? 'All agents connected. Opening town…'
        : 'A fresh Claude CLI cold-start runs 30-60s per agent. Grab a coffee.');

  body.innerHTML = `
    <div class="setup-launching">
      <div class="spinner large"></div>
      <div class="launching-title">${done} / ${total} agent${total === 1 ? '' : 's'} connected</div>
      <div class="launching-progress"><div class="launching-bar" style="width:${pct}%"></div></div>
      <div class="launching-sub">${status}</div>
    </div>
  `;
}

function hideLaunchingOverlay() {
  if (!LaunchProgress.pending) return;
  if (LaunchProgress.pending.timer) clearTimeout(LaunchProgress.pending.timer);
  LaunchProgress.pending = null;
}

function waitForAgentsToJoin(expected, timeoutMs) {
  return new Promise(resolve => {
    const p = LaunchProgress.pending;
    if (!p || expected <= 0) return resolve(true);
    if (p.joined.size >= expected) return resolve(true);
    p.resolver = resolve;
    p.timer = setTimeout(() => {
      if (p.resolver) { p.resolver = null; resolve(false); }
    }, timeoutMs);
  });
}

// Called from appendEvent whenever a 'join' event comes through.
function recordJoinForLaunch(entry) {
  const p = LaunchProgress.pending;
  if (!p || !entry.agentId) return;
  // Only count agents we were actually waiting on — ignores the player's own
  // join event and any re-registration noise.
  if (!p.expectedIds.has(entry.agentId)) return;
  if (p.joined.has(entry.agentId)) return;
  p.joined.add(entry.agentId);
  renderLaunchingOverlay();
  if (p.joined.size >= p.expectedIds.size && p.resolver) {
    const done = p.resolver;
    p.resolver = null;
    if (p.timer) clearTimeout(p.timer);
    done(true);
  }
}

async function launchGame() {
  const pc = (Setup.playerIndex >= 0 && Setup.playerIndex < Setup.characters.length)
    ? Setup.characters[Setup.playerIndex]
    : null;
  await doLaunch({
    selectedName:  pc ? pc.name : null,
    selectedRole:  pc ? pc.role : null,
    allCharacters: Setup.characters,
  });
}

// ─── WebSocket ─────────────────────────────────────────────────────────────────

function connectWS() {
  App.ws = new WebSocket(WS_URL);

  App.ws.onopen  = () => setStatus(true);
  App.ws.onclose = () => { setStatus(false); setTimeout(connectWS, 3000); };
  App.ws.onerror = () => setStatus(false);

  App.ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        App.worldState = msg.state;
        render(msg.state);
        updatePlayerPanel(msg.state);
      }
      if (msg.type === 'event' && msg.event) {
        appendEvent(msg.event);
      }
    } catch {}
  };
}

function setStatus(connected) {
  const el = document.getElementById('connection-status');
  if (!el) return;
  el.textContent = connected ? '🟢 connected' : '🔴 reconnecting…';
  el.className   = connected ? 'connected' : 'disconnected';
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

function render(state) {
  if (!state) return;
  const all      = Object.values(state.agents || {});
  const active   = all.filter(a => a.active);
  const dropped  = all.filter(a => !a.active && !a.isPlayer);

  const countEl = document.getElementById('agent-count');
  if (countEl) countEl.textContent = `${active.length} character${active.length !== 1 ? 's' : ''}`;

  renderMap(active, state);
  renderCharacters(active, dropped);
  if (!App.feedRendered) renderFeedFromState(state);

  // Player badge in header
  if (App.playerId) {
    const badge = document.getElementById('player-badge');
    if (badge) { badge.textContent = `Playing as ${App.playerName}`; badge.classList.remove('hidden'); }
    const ob = document.getElementById('btn-observe');
    if (ob) ob.style.display = '';
  }
}

// ── Map ────────────────────────────────────────────────────────────────────────

function renderMap(agents, state) {
  const grid = document.getElementById('location-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const hint = document.getElementById('map-hint');
  if (hint) hint.textContent = App.playerId ? 'Click a location to move' : '';

  const myAgent = App.playerId && state && state.agents ? state.agents[App.playerId] : null;

  for (const loc of LOCATIONS) {
    const here = agents.filter(a => a.location === loc.id);
    const isCurrent = myAgent && myAgent.location === loc.id;

    const card = document.createElement('div');
    card.className = [
      'location-card',
      here.length ? 'has-people' : '',
      isCurrent   ? 'is-current' : '',
      App.playerId && !isCurrent ? 'clickable' : '',
    ].filter(Boolean).join(' ');

    if (App.playerId && !isCurrent) {
      card.onclick = () => playerAction('move', { destination: loc.id });
      card.title   = `Move to ${loc.name}`;
    }

    card.innerHTML = `
      <div class="loc-header">
        <span class="loc-emoji">${loc.emoji}</span>
        <span class="loc-name">${loc.name}</span>
        ${isCurrent ? '<span class="you-badge">YOU</span>' : ''}
      </div>
      <div class="loc-people">
        ${here.map(a => `<span class="person-dot${a.id === App.playerId ? ' is-player' : ''}">${escHtml(a.name)}</span>`).join('')}
      </div>
    `;
    grid.appendChild(card);
  }
}

// ── Characters panel ───────────────────────────────────────────────────────────

function renderCharacters(agents, dropped = []) {
  const list = document.getElementById('character-list');
  if (!list) return;
  list.innerHTML = '';

  if (!agents.length && !dropped.length) {
    list.innerHTML = `<div class="empty-msg">No characters in town yet.</div>`;
    return;
  }

  const sorted = [...agents].sort((a, b) => {
    if (a.id === App.playerId) return -1;
    if (b.id === App.playerId) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const a of sorted) {
    const isMe  = a.id === App.playerId;
    const locObj = LOCATIONS.find(l => l.id === a.location);
    const locStr = locObj ? `${locObj.emoji} ${locObj.name}` : a.location;
    const lastMsg = lastSaid[a.id];

    const card = document.createElement('div');
    card.className = `character-card${isMe ? ' is-player' : ''}`;
    card.innerHTML = `
      <div class="char-header">
        <span class="char-name${isMe ? ' is-player' : ''}">${escHtml(a.name)}${isMe ? ' ★' : ''}</span>
        <span class="char-role">${escHtml(a.role)}</span>
      </div>
      <div class="char-location">${locStr}</div>
      ${lastMsg ? `<div class="char-last-said">"${escHtml(lastMsg)}"</div>` : ''}
      ${!isMe && !App.playerId ? `<button class="play-as-btn" data-name="${escHtml(a.name)}" data-role="${escHtml(a.role)}">▶ Play as</button>` : ''}
    `;
    list.appendChild(card);
  }

  // Disconnected AI characters — show dimmed, clearly labelled.
  for (const a of dropped) {
    const locObj = LOCATIONS.find(l => l.id === a.location);
    const locStr = locObj ? `${locObj.emoji} ${locObj.name}` : a.location;
    const card = document.createElement('div');
    card.className = 'character-card disconnected';
    card.innerHTML = `
      <div class="char-header">
        <span class="char-name">${escHtml(a.name)}</span>
        <span class="char-role">${escHtml(a.role)}</span>
      </div>
      <div class="char-location">${locStr}</div>
      <div class="char-disconnect">⚠ Agent stopped responding</div>
    `;
    list.appendChild(card);
  }

  // Attach play-as handlers for observer mode
  list.querySelectorAll('.play-as-btn').forEach(btn => {
    btn.onclick = async () => {
      const name = btn.dataset.name;
      const role = btn.dataset.role;
      try {
        const data = await apiFetch('/api/register', 'POST', { name, role, isPlayer: true });
        if (data.success) {
          App.playerId   = data.agent.id;
          App.playerName = name;
          setupPlayerPanel();
          render(App.worldState);
        }
      } catch (err) { alert('Error: ' + err.message); }
    };
  });
}

// ─── Event feed ────────────────────────────────────────────────────────────────

function renderFeedFromState(state) {
  const feed = document.getElementById('event-feed');
  if (!feed) return;
  feed.innerHTML = '';
  const entries = (state.eventLog || []).slice(-80);
  for (const entry of entries) appendEvent(entry, false);
  App.feedRendered = true;
  scrollFeedToBottom();
}

function appendEvent(entry, animate = true) {
  if (!entry || !entry.type) return;  // skip malformed entries (raw results from old code)

  // Forward to the launch-progress tracker (runs even when overlay is visible
  // and event-feed isn't yet rendered).
  if (entry.type === 'join') recordJoinForLaunch(entry);

  // Surface a disconnect as a toast so the player notices mid-game.
  if (entry.type === 'disconnect') {
    showNotification(`⚠ ${entry.text}`);
  }

  const feed = document.getElementById('event-feed');
  if (!feed) return;

  // Track last said per agent (strip quotes from format `Name: "text"`)
  if (entry.type === 'speak' && entry.agentId) {
    const m = entry.text.match(/^[^:]+:\s*"?(.+?)"?\s*$/s);
    if (m) lastSaid[entry.agentId] = m[1];
  }

  const isPlayerEvent = entry.agentId === App.playerId;
  const mentionsPlayer = App.playerName && entry.text &&
    entry.text.toLowerCase().includes(App.playerName.toLowerCase());

  const el = document.createElement('div');
  el.className = [
    'feed-entry',
    entry.type,
    isPlayerEvent  ? 'by-player'      : '',
    mentionsPlayer && !isPlayerEvent ? 'mentions-player' : '',
  ].filter(Boolean).join(' ');

  if (!animate) el.style.animation = 'none';
  el.innerHTML = buildEntryHTML(entry);
  feed.appendChild(el);

  while (feed.children.length > 200) feed.removeChild(feed.firstChild);

  const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 60;
  if (atBottom) scrollFeedToBottom();

  // Notify player if someone at their location calls their name
  if (App.playerId && mentionsPlayer && !isPlayerEvent && entry.type === 'speak') {
    const myAgent = App.worldState?.agents?.[App.playerId];
    if (myAgent && entry.locationId === myAgent.location) {
      const speaker = entry.text.split(':')[0].trim();
      showNotification(`${speaker} is talking to you!`);
    }
  }
}

function buildEntryHTML(entry) {
  const ts       = formatTime(entry.ts);
  const tsHtml   = ts ? `<span class="ts">${ts}</span>` : '';
  const locObj   = LOCATIONS.find(l => l.id === entry.locationId);
  const locBadge = locObj ? `<span class="loc-tag">${locObj.emoji} ${locObj.name}</span> ` : '';

  switch (entry.type) {
    case 'speak': {
      // Format: `Name: "message"` — split on first colon only
      const colonIdx     = entry.text.indexOf(':');
      const speakerName  = colonIdx > -1 ? entry.text.slice(0, colonIdx).trim() : '';
      const rawMessage   = colonIdx > -1 ? entry.text.slice(colonIdx + 1).trim() : entry.text;
      const plainMessage = rawMessage.replace(/^"(.+)"$/, '$1');  // strip surrounding quotes
      const said         = escHtml(plainMessage);
      const isMe         = entry.agentId === App.playerId;
      const spClass      = isMe ? 'speaker you' : 'speaker';
      const spLabel      = escHtml(isMe ? `${speakerName} (You)` : speakerName);
      const toTag        = buildRecipientTag(speakerName, plainMessage, entry.locationId);
      return `${tsHtml}${locBadge}<span class="${spClass}">${spLabel}:</span>${toTag} <span class="said">${said}</span>`;
    }
    case 'shout': {
      // Format: `Name shouts: "message"`
      const m       = entry.text.match(/^(.+?) shouts:\s*(.+)$/s);
      const speaker = m ? escHtml(m[1].trim()) : '';
      const raw     = m ? m[2].trim() : entry.text;
      const said    = escHtml(raw.replace(/^"(.+)"$/, '$1'));
      return `${tsHtml}📢 <span class="speaker shout">${speaker} shouts:</span> <span class="said">${said}</span>`;
    }
    case 'whisper': {
      const isMe = entry.agentId === App.playerId;
      return `${tsHtml}🤫 <span class="${isMe ? 'speaker you' : 'speaker dim'}">${escHtml(entry.text)}</span>`;
    }
    case 'think':
      return `${tsHtml}💭 <em class="think-text">${escHtml(entry.text)}</em>`;
    case 'move':
      return `${tsHtml}<span class="sys-text">${escHtml(entry.text)}</span>`;
    case 'join':
      return `${tsHtml}✦ <span class="join-text">${escHtml(entry.text)}</span>`;
    case 'leave':
      return `${tsHtml}✧ <span class="leave-text">${escHtml(entry.text)}</span>`;
    case 'reset':
      return `${tsHtml}⚠️ <span class="reset-text">${escHtml(entry.text)}</span>`;
    case 'disconnect':
      return `${tsHtml}⚠ <span class="disconnect-text">${escHtml(entry.text)}</span>`;
    default:
      return `${tsHtml}${escHtml(entry.text || '')}`;
  }
}

// Decide who a line of speech was aimed at, based on who else is at the
// speaker's location and whether any of their names appear in the message.
function buildRecipientTag(speakerName, message, locationId) {
  const agents = Object.values(App.worldState?.agents || {})
    .filter(a => a.active && a.name !== speakerName);

  const othersHere = agents
    .filter(a => a.location === locationId)
    .map(a => a.name);

  if (othersHere.length === 0) return '';

  const msgLower   = (message || '').toLowerCase();
  const mentioned  = othersHere.filter(name => msgLower.includes(name.toLowerCase()));

  if (mentioned.length > 0) {
    return ` <span class="to-tag to-direct">→ ${escHtml(mentioned.join(', '))}</span>`;
  }
  const label = othersHere.length === 1
    ? `to ${othersHere[0]}`
    : `to everyone here (${othersHere.join(', ')})`;
  return ` <span class="to-tag">${escHtml(label)}</span>`;
}

function scrollFeedToBottom() {
  const feed = document.getElementById('event-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

// ─── Player panel ──────────────────────────────────────────────────────────────

function setupPlayerPanel() {
  const panel = document.getElementById('player-panel');
  if (!panel || !App.playerId) return;
  panel.classList.remove('hidden');

  // Move buttons
  const moveBtns = document.getElementById('move-btns');
  if (moveBtns) {
    moveBtns.innerHTML = LOCATIONS.map(loc => `
      <button class="move-btn" data-loc="${loc.id}" title="${loc.name}">
        ${loc.emoji} ${loc.short}
      </button>
    `).join('');
    moveBtns.querySelectorAll('.move-btn').forEach(btn => {
      btn.onclick = () => playerAction('move', { destination: btn.dataset.loc });
    });
  }

  // Say — typing pauses the world so NPCs don't cut you off
  const sayBtn   = document.getElementById('say-btn');
  const sayInput = document.getElementById('say-input');
  if (sayBtn)   sayBtn.onclick = playerSay;
  if (sayInput) {
    sayInput.onkeydown = e => { if (e.key === 'Enter') playerSay(); };
    sayInput.oninput   = syncPauseState;
    sayInput.onblur    = syncPauseState;
  }

  // Whisper
  const whisperBtn   = document.getElementById('whisper-btn');
  const whisperInput = document.getElementById('whisper-input');
  const whisperSel   = document.getElementById('whisper-target');
  if (whisperBtn) whisperBtn.onclick = playerWhisper;
  if (whisperInput) {
    whisperInput.onkeydown = e => { if (e.key === 'Enter') playerWhisper(); };
    whisperInput.oninput   = syncPauseState;
    whisperInput.onblur    = syncPauseState;
  }
  if (whisperSel) whisperSel.onchange = syncPauseState;

  // Look — show who's here and what's been said
  const lookBtn = document.getElementById('look-btn');
  if (lookBtn) {
    lookBtn.onclick = async () => {
      const data = await playerAction('look');
      if (!data?.success) return;
      const here = (data.charactersHere || []).map(c => c.name);
      if (here.length === 0 && data.recentMessages?.length === 0) {
        showNotification('Nobody else is here and nothing has been said recently.');
      } else if (here.length === 0) {
        showNotification('Nobody else is here right now.');
      } else {
        showNotification(`Here with you: ${here.join(', ')}.`);
      }
    };
  }

  // Stop playing — return to observer mode
  const stopBtn = document.getElementById('btn-stop-playing');
  if (stopBtn) {
    stopBtn.onclick = async () => {
      await resumeWorld();
      App.playerId   = null;
      App.playerName = null;
      panel.classList.add('hidden');
      const badge = document.getElementById('player-badge');
      if (badge) badge.classList.add('hidden');
      const ob = document.getElementById('btn-observe');
      if (ob) ob.style.display = 'none';
      if (App.worldState) renderCharacters(Object.values(App.worldState.agents || {}).filter(a => a.active));
    };
  }

  // Header observer button mirrors stop-playing
  const hdrOb = document.getElementById('btn-observe');
  if (hdrOb) {
    hdrOb.style.display = '';
    hdrOb.onclick = () => document.getElementById('btn-stop-playing').click();
  }

  if (App.worldState) updatePlayerPanel(App.worldState);

  // Auto-focus the say input so the player can start typing immediately
  setTimeout(() => document.getElementById('say-input')?.focus(), 100);
}

function updatePlayerPanel(state) {
  if (!App.playerId || !state) return;
  const panel = document.getElementById('player-panel');
  if (!panel || panel.classList.contains('hidden')) return;

  const agent = state.agents?.[App.playerId];
  if (!agent) return;

  const locObj = LOCATIONS.find(l => l.id === agent.location);
  const whoEl  = document.getElementById('player-who');
  const whereEl = document.getElementById('player-where');
  if (whoEl)   whoEl.textContent   = `Playing as ${agent.name}`;
  if (whereEl) whereEl.textContent = locObj ? `${locObj.emoji} ${locObj.name}` : agent.location;

  // Highlight current-location move buttons
  document.querySelectorAll('.move-btn').forEach(btn => {
    const isCur = btn.dataset.loc === agent.location;
    btn.classList.toggle('current', isCur);
    btn.disabled = isCur;
  });

  // Populate whisper dropdown — but ONLY if the set of options actually changed.
  // Rebuilding every state tick would wipe the user's current selection and
  // could blur the input while they're typing.
  const whisperTarget = document.getElementById('whisper-target');
  if (whisperTarget) {
    const others = Object.values(state.agents || {})
      .filter(a => a.active && a.id !== App.playerId);

    // Whispers only work at the same location — only offer people here.
    const here = others
      .filter(a => a.location === agent.location)
      .sort((a, b) => a.name.localeCompare(b.name));

    const signature = here.map(a => a.name).join('|');
    if (whisperTarget._signature !== signature) {
      const prevValue = whisperTarget.value;

      whisperTarget.innerHTML = `<option value="">Whisper to…</option>`;
      if (here.length) {
        const grp = document.createElement('optgroup');
        grp.label = 'Here with you';
        here.forEach(a => {
          const opt = document.createElement('option');
          opt.value = a.name; opt.textContent = a.name;
          grp.appendChild(opt);
        });
        whisperTarget.appendChild(grp);
      }
      whisperTarget._signature = signature;

      // Preserve the user's selection if it still exists at this location.
      if (prevValue && here.some(a => a.name === prevValue)) {
        whisperTarget.value = prevValue;
      } else if (prevValue) {
        whisperTarget.value = '';
        showNotification(`${prevValue} is no longer here — whisper cancelled.`);
        syncPauseState();
      }
    }
  }
}

function showNotification(text) {
  const el = document.getElementById('player-notification');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 6000);
}

async function playerSay() {
  const input = document.getElementById('say-input');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg || !App.playerId) return;
  input.value = '';
  await playerAction('speak', { message: msg });
  await resumeWorld();
  input.focus();
}

async function playerWhisper() {
  const targetSel = document.getElementById('whisper-target');
  const target    = targetSel?.value;
  const input     = document.getElementById('whisper-input');
  const message   = input?.value.trim();
  if (!App.playerId) return;
  if (!target)  { showNotification('Choose who to whisper to first.'); return; }
  if (!message) { showNotification('Type a message before whispering.'); return; }
  if (input) input.value = '';

  const result = await playerAction('whisper', { target, message });

  // Clear selection and let the world resume.
  if (targetSel) targetSel.value = '';
  await resumeWorld();

  if (result && !result.success) {
    showNotification(result.error || 'Whisper failed.');
  }
}


async function playerAction(action, args = {}) {
  if (!App.playerId) return null;
  // Any deliberate action by the player ends their "composing" state.
  if (action === 'move') await resumeWorld();
  try {
    return await apiFetch('/api/action', 'POST', { agentId: App.playerId, action, args });
  } catch (err) {
    console.error('Action failed:', err);
    return null;
  }
}

// ─── World pause (active while player is composing) ──────────────────────────

async function pauseWorld() {
  if (worldPaused || !App.playerId) return;
  worldPaused = true;
  renderPauseIndicator();
  try {
    await apiFetch('/api/pause', 'POST', { paused: true, holderId: App.playerId });
  } catch (err) { console.warn('pause failed:', err); }
}

async function resumeWorld() {
  if (!worldPaused) return;
  worldPaused = false;
  renderPauseIndicator();
  try {
    await apiFetch('/api/pause', 'POST', { paused: false, holderId: App.playerId });
  } catch (err) { console.warn('resume failed:', err); }
}

// Inspect current input state and pause/resume accordingly. Called on every
// input/blur/change event on the composing widgets.
function syncPauseState() {
  if (!App.playerId) { if (worldPaused) resumeWorld(); return; }
  const sayInput = document.getElementById('say-input');
  const whInput  = document.getElementById('whisper-input');
  const whTarget = document.getElementById('whisper-target');
  const composing =
    (sayInput && sayInput.value.trim().length > 0) ||
    (whInput  && whInput.value.trim().length  > 0) ||
    (whTarget && whTarget.value);
  if (composing && !worldPaused) pauseWorld();
  else if (!composing && worldPaused) resumeWorld();
}

function renderPauseIndicator() {
  let el = document.getElementById('pause-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pause-indicator';
    el.className = 'pause-indicator hidden';
    el.textContent = '⏸ Town paused while you compose';
    const panel = document.getElementById('player-panel');
    if (panel && panel.firstChild) panel.insertBefore(el, panel.firstChild);
    else if (panel) panel.appendChild(el);
  }
  el.classList.toggle('hidden', !worldPaused);
}

// Release the world pause if the tab closes mid-compose.
window.addEventListener('beforeunload', () => {
  if (!worldPaused) return;
  try {
    navigator.sendBeacon(
      '/api/pause',
      new Blob(
        [JSON.stringify({ paused: false, holderId: App.playerId })],
        { type: 'application/json' },
      ),
    );
  } catch {}
});

// ─── Game controls ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // New game button — stops agents, wipes characters, starts wizard
  document.getElementById('btn-new-game')?.addEventListener('click', async () => {
    if (!confirm('Start a new game? This will close all agent windows, delete all characters, and reset the world.')) return;
    const btn = document.getElementById('btn-new-game');
    btn.disabled = true;
    btn.textContent = 'Resetting…';
    try {
      await apiFetch('/api/game/stop', 'POST');      // kill agent terminals
      await apiFetch('/api/characters', 'DELETE');   // wipe character files + world
      App.playerId     = null;
      App.playerName   = null;
      App.feedRendered = false;
      Object.keys(lastSaid).forEach(k => delete lastSaid[k]);
      showSetupWizard();
    } catch (err) { alert('Error: ' + err.message); }
    finally { btn.disabled = false; btn.textContent = 'New Game'; }
  });

  // Clear feed
  document.getElementById('clear-feed')?.addEventListener('click', () => {
    const feed = document.getElementById('event-feed');
    if (feed) feed.innerHTML = '';
    App.feedRendered = false;
  });
});

// ─── Utilities ────────────────────────────────────────────────────────────────

async function apiFetch(url, method = 'GET', body = null) {
  const opts = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Start ──────────────────────────────────────────────────────────────────────

init();
