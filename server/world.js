// WorldOfFolks 2 — World Simulation Engine
// Simplified: 7 locations, focus on character & dialogue.

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'characters', 'world_state.json');
const MEMORIES_DIR = path.join(__dirname, '..', 'characters', 'memories');

const LOCATIONS = {
  square:     { id: 'square',     name: 'Town Square', emoji: '🏛️',  description: 'The central hub. Benches, a notice board, foot traffic. Everyone passes through.' },
  tavern:     { id: 'tavern',     name: 'Tavern',      emoji: '🍺',  description: 'Dim, warm, loud by evening. The social heart of the town.' },
  market:     { id: 'market',     name: 'Market',      emoji: '🏪',  description: 'Stalls, haggling, transactions. Where deals happen and debts get called in.' },
  park:       { id: 'park',       name: 'Park',        emoji: '🌳',  description: 'Quiet paths, a pond, a bench under an old tree. Good for thinking — or hiding.' },
  blacksmith: { id: 'blacksmith', name: 'Blacksmith',  emoji: '⚒️',  description: 'Loud, hot, always working. Few visit unless they need something.' },
  library:    { id: 'library',    name: 'Library',     emoji: '📚',  description: 'Small but old. Half the books are catalogued. Secrets live in old records.' },
  docks:      { id: 'docks',      name: 'Docks',       emoji: '⚓',  description: 'End of the main road. Boats, water, distance. People come here when they\'re leaving, or thinking about it.' },
};

const LOCATION_IDS = Object.keys(LOCATIONS);

class World {
  constructor(opts = {}) {
    this.tick = 0;
    this.agents = {};     // id -> agent object
    this.eventLog = [];   // recent world events (capped at 200)
    this.eventCount = 0;  // monotonic total of events ever logged. Used by the
                          // broadcast layer to compute "what's new since X"
                          // correctly even after the cap rotates eventLog.
    this.messages = {};   // locationId -> [{speaker, agentId, text, tick}]  (last 20 per location)
    this.whispers = {};   // targetId -> [{from, text, tick}]
    this.pids = {};       // agentId -> pid (for killing processes on reset)
    this.worldPause = null;  // { holder: playerId, until: ts } — while set, AI actions that affect others wait

    // Init message buckets
    for (const loc of LOCATION_IDS) this.messages[loc] = [];

    // Tests pass { load: false, persist: false } so they get an isolated world
    // that doesn't read or write characters/world_state.json.
    if (opts.load !== false) this.loadState();
    if (opts.persist !== false) {
      this.saveInterval = setInterval(() => this.saveState(), 30000);
    }
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.agents   = data.agents   || {};
        this.eventLog = data.eventLog || [];
        this.messages = data.messages || {};
        for (const loc of LOCATION_IDS) {
          if (!this.messages[loc]) this.messages[loc] = [];
        }
        // Persisted agents carry their last location but are NOT live until a
        // subprocess registers for them again. Without this reset, the browser
        // would think the town is already running and skip the welcome-back
        // prompt.
        for (const id of Object.keys(this.agents)) {
          this.agents[id].active = false;
        }
        // Re-anchor the monotonic counter so broadcast deltas (eventCount -
        // prevCount) line up with eventLog after a restart.
        this.eventCount = this.eventLog.length;
        console.log(`[World] Loaded state: ${Object.keys(this.agents).length} agents (awaiting launch)`);
      }
    } catch (err) {
      console.error('[World] Failed to load state:', err.message);
    }
  }

  saveState() {
    try {
      if (!fs.existsSync(path.dirname(STATE_FILE))) {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        agents:   this.agents,
        eventLog: this.eventLog.slice(-200),
        messages: this.messages,
      }, null, 2));
    } catch (err) {
      console.error('[World] Failed to save state:', err.message);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _log(type, text, agentId = null, locationId = null) {
    const entry = { type, text, agentId, locationId, tick: this.tick, ts: Date.now() };
    this.eventLog.push(entry);
    if (this.eventLog.length > 200) this.eventLog.shift();
    this.eventCount++;
    return entry;
  }

  _resolveLocation(input) {
    if (!input) return null;
    const key = input.toLowerCase().trim().replace(/\s+/g, '_');
    // Exact match
    if (LOCATIONS[key]) return key;
    // Match by name (fuzzy)
    for (const [id, loc] of Object.entries(LOCATIONS)) {
      if (loc.name.toLowerCase() === input.toLowerCase().trim()) return id;
      if (id.includes(key) || key.includes(id)) return id;
    }
    return null;
  }

  _agentsAt(locationId) {
    return Object.values(this.agents).filter(a => a.location === locationId && a.active);
  }

  _recentMessages(locationId, maxAge = 80, maxCount = 12) {
    return (this.messages[locationId] || [])
      .filter(m => (this.tick - m.tick) <= maxAge)
      .slice(-maxCount);
  }

  _buildConversationContext(agentId, locationId, triggerMessage = null) {
    const recent = this._recentMessages(locationId);
    const agent  = this.agents[agentId];
    if (!recent.length && !triggerMessage) return null;

    const others = this._agentsAt(locationId)
      .filter(a => a.id !== agentId)
      .map(a => a.name);

    let directlyAddressed = false;
    if (agent) {
      const myName = agent.name.toLowerCase();
      for (const msg of recent) {
        if (msg.agentId !== agentId && msg.text.toLowerCase().includes(myName)) {
          directlyAddressed = true;
          break;
        }
      }
      if (triggerMessage && triggerMessage.toLowerCase().includes(myName)) {
        directlyAddressed = true;
      }
    }

    return {
      messages:          recent.map(m => ({ speaker: m.speaker, text: m.text })),
      othersHere:        others,
      directlyAddressed,
    };
  }

  _nameToId(name) {
    return name.toLowerCase().replace(/\s+/g, '_');
  }

  // Mark an agent as having just taken an action. Used for stall detection —
  // an AI agent whose subprocess is alive but hasn't called any action in a
  // long time is wedged (Claude CLI hung, rate-limited, lost session, etc.)
  // and should be restarted.
  _touch(agentId) {
    const a = this.agents[agentId];
    if (a) a.lastActionAt = Date.now();
  }

  // Returns AI agents (non-player) that are marked active but haven't acted
  // within `thresholdMs`. The supervisor restarts these.
  getStalledAIAgents(thresholdMs) {
    const cutoff = Date.now() - thresholdMs;
    return Object.values(this.agents).filter(a =>
      a.active && !a.isPlayer && (a.lastActionAt || 0) < cutoff
    );
  }

  // ─── Actions ─────────────────────────────────────────────────────────────────

  register(name, role, isPlayer = false) {
    const id = this._nameToId(name);
    if (this.agents[id]) {
      // Re-registering (e.g. agent restarted, or a human is taking over an
      // existing character). Always refresh isPlayer so a takeover from the
      // observer "Play as" button correctly flips the flag — otherwise the
      // health check below would treat the player's character as a dead AI.
      this.agents[id].active       = true;
      this.agents[id].isPlayer     = isPlayer;
      this.agents[id].lastActionAt = Date.now();
      // If this re-register is an AI restart, remember it so a future missing
      // pid file is treated as "process died" rather than "never launched".
      if (!isPlayer) this.agents[id].wasLaunchedAI = true;
      this._log('join', `${name} returned to town`, id, this.agents[id].location);
      return { success: true, agent: this.agents[id] };
    }

    const agent = {
      id,
      name,
      role,
      isPlayer,
      location: 'square',
      active: true,
      joinedAt:      Date.now(),
      lastActionAt:  Date.now(),
      wasLaunchedAI: !isPlayer, // see comment in checkAgentHealth
    };
    this.agents[id] = agent;
    this._log('join', `${name} (${role}) arrived in town`, id, 'square');
    return { success: true, agent };
  }

  deregister(agentId) {
    const agent = this.agents[agentId];
    if (!agent) return { success: false, error: 'Unknown agent' };
    agent.active = false;
    this._log('leave', `${agent.name} left town`, agentId, agent.location);
    return { success: true };
  }

  look(agentId) {
    const agent = this.agents[agentId];
    if (!agent) return { success: false, error: 'Unknown agent' };
    this._touch(agentId);

    const loc     = LOCATIONS[agent.location];
    const others  = this._agentsAt(agent.location).filter(a => a.id !== agentId);
    const recent  = this._recentMessages(agent.location);
    const context = this._buildConversationContext(agentId, agent.location);
    const whisps  = (this.whispers[agentId] || []).splice(0); // consume whispers

    return {
      success:             true,
      location:            loc.name,
      locationId:          agent.location,
      description:         loc.description,
      charactersHere:      others.map(a => ({ name: a.name, role: a.role })),
      recentMessages:      recent.map(m => ({ speaker: m.speaker, text: m.text })),
      whispers:            whisps,
      conversationContext: context,
      allLocations:        Object.values(LOCATIONS).map(l => ({
        id:         l.id,
        name:       l.name,
        emoji:      l.emoji,
        population: this._agentsAt(l.id).length,
      })),
    };
  }

  move(agentId, destination) {
    const agent = this.agents[agentId];
    if (!agent) return { success: false, error: 'Unknown agent' };
    this._touch(agentId);

    const destId = this._resolveLocation(destination);
    if (!destId) {
      return {
        success: false,
        error: `Unknown location: "${destination}". Valid locations: ${LOCATION_IDS.join(', ')}`,
      };
    }
    if (destId === agent.location) {
      return { success: false, error: `You are already at ${LOCATIONS[destId].name}.` };
    }

    const from = agent.location;
    agent.location = destId;
    this._log('move', `${agent.name} moved from ${LOCATIONS[from].name} to ${LOCATIONS[destId].name}`, agentId, destId);

    const others  = this._agentsAt(destId).filter(a => a.id !== agentId);
    const recent  = this._recentMessages(destId);
    const context = this._buildConversationContext(agentId, destId);

    return {
      success:             true,
      location:            LOCATIONS[destId].name,
      locationId:          destId,
      description:         LOCATIONS[destId].description,
      charactersHere:      others.map(a => ({ name: a.name, role: a.role })),
      recentMessages:      recent.map(m => ({ speaker: m.speaker, text: m.text })),
      conversationContext: context,
    };
  }

  speak(agentId, message) {
    const agent = this.agents[agentId];
    if (!agent) return { success: false, error: 'Unknown agent' };
    if (!message || !message.trim()) return { success: false, error: 'Nothing to say.' };
    this._touch(agentId);

    const text  = message.trim();
    const entry = { speaker: agent.name, agentId, text, tick: this.tick };
    this.messages[agent.location].push(entry);
    if (this.messages[agent.location].length > 20) this.messages[agent.location].shift();

    this._log('speak', `${agent.name}: "${text}"`, agentId, agent.location);
    this.tick++;

    const others  = this._agentsAt(agent.location).filter(a => a.id !== agentId);
    const context = this._buildConversationContext(agentId, agent.location, text);

    return {
      success:        true,
      location:       LOCATIONS[agent.location].name,
      spoke:          text,
      charactersHere: others.map(a => ({ name: a.name, role: a.role })),
      conversationContext: context,
    };
  }

  shout(agentId, message) {
    const agent = this.agents[agentId];
    if (!agent) return { success: false, error: 'Unknown agent' };
    if (!message || !message.trim()) return { success: false, error: 'Nothing to shout.' };
    this._touch(agentId);

    const text = message.trim();
    // Broadcast to ALL locations
    for (const locId of LOCATION_IDS) {
      this.messages[locId].push({ speaker: agent.name, agentId, text: `[SHOUT] ${text}`, tick: this.tick });
      if (this.messages[locId].length > 20) this.messages[locId].shift();
    }
    this._log('shout', `${agent.name} shouts: "${text}"`, agentId, agent.location);
    this.tick++;

    return { success: true, shouted: text };
  }

  whisper(agentId, targetName, message) {
    const agent  = this.agents[agentId];
    if (!agent) return { success: false, error: 'Unknown agent' };
    if (!message || !message.trim()) return { success: false, error: 'Nothing to whisper.' };
    this._touch(agentId);

    const targetId = this._nameToId(targetName);
    const target   = this.agents[targetId];
    if (!target || !target.active) {
      return { success: false, error: `${targetName} is not in town.` };
    }
    if (target.id === agent.id) {
      return { success: false, error: `You can't whisper to yourself.` };
    }
    if (target.location !== agent.location) {
      return {
        success: false,
        error: `${target.name} isn't here — you can only whisper to someone at your location.`,
      };
    }

    const text = message.trim();
    if (!this.whispers[targetId]) this.whispers[targetId] = [];
    this.whispers[targetId].push({ from: agent.name, text, tick: this.tick });

    this._log('whisper', `${agent.name} whispered to ${target.name}: "${text}"`, agentId, agent.location);
    return { success: true, to: target.name, message: text };
  }

  think(agentId, thought) {
    const agent = this.agents[agentId];
    if (!agent) return { success: false, error: 'Unknown agent' };
    this._touch(agentId);

    this._log('think', `[${agent.name} thinks]: ${thought}`, agentId, agent.location);
    return { success: true, thought: thought.trim() };
  }

  remember(agentId, text) {
    const agent = this.agents[agentId];
    if (!agent) return { success: false, error: 'Unknown agent' };
    this._touch(agentId);

    if (!fs.existsSync(MEMORIES_DIR)) fs.mkdirSync(MEMORIES_DIR, { recursive: true });
    const file = path.join(MEMORIES_DIR, `${agentId}.txt`);
    const line = `[${new Date().toISOString()}] ${text.trim()}\n`;
    fs.appendFileSync(file, line);

    return { success: true, remembered: text.trim() };
  }

  // ─── World pause (player is composing — freeze AI actions that affect others) ─

  // TTL is short on purpose: the client refreshes this every few seconds while
  // the player is actively composing. A short ceiling means a stuck pause
  // (e.g. dropped resume request) self-heals in ~15s instead of 2 minutes.
  pause(holderId, ttlMs = 15_000) {
    this.worldPause = { holder: holderId || null, until: Date.now() + ttlMs };
    return { success: true, until: this.worldPause.until };
  }

  resume(holderId) {
    if (!this.worldPause) return { success: true };
    if (holderId && this.worldPause.holder && this.worldPause.holder !== holderId) {
      return { success: false, error: 'Paused by someone else' };
    }
    this.worldPause = null;
    return { success: true };
  }

  // Called by the action handler after the pause holder takes any action.
  // The holder finishing an action means they're no longer composing, so we
  // clear the pause unconditionally. Returns true if a pause was cleared
  // (so the server can broadcast the new pause state).
  clearPauseFor(agentId) {
    if (!this.worldPause) return false;
    if (this.worldPause.holder && this.worldPause.holder !== agentId) return false;
    this.worldPause = null;
    return true;
  }

  // True if AI action by `agentId` should wait for the world to unpause.
  // The pause holder's own actions always go through.
  isActionBlocked(agentId) {
    if (!this.worldPause) return false;
    if (this.worldPause.until <= Date.now()) { this.worldPause = null; return false; }
    if (this.worldPause.holder === agentId) return false;
    return true;
  }

  // ─── Agent health ────────────────────────────────────────────────────────────
  // Marks agents whose process has died as inactive. Returns the list of agent
  // ids that just flipped from active to inactive (server broadcasts them).

  checkAgentHealth() {
    const PIDS_DIR = path.join(__dirname, '..', 'characters', '.pids');
    const dropped  = [];

    for (const agent of Object.values(this.agents)) {
      if (!agent.active || agent.isPlayer) continue;

      const pidFile = path.join(PIDS_DIR, `${agent.id}.pid`);

      // Only treat a missing PID file as "dead" if we know the agent was
      // launched as an AI in this session (i.e. they've actually taken some
      // action via /api/action — wasLaunchedAI is set there). Without that
      // flag, this could be a hand-registered test agent that never had a
      // pid in the first place.
      let alive;
      if (!fs.existsSync(pidFile)) {
        if (!agent.wasLaunchedAI) continue;
        alive = false;
      } else {
        alive = false;
        try {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
          if (pid) {
            try { process.kill(pid, 0); alive = true; }
            catch { alive = false; }
          }
        } catch {}
      }

      if (!alive) {
        agent.active = false;
        this._log('disconnect', `${agent.name} went quiet — their agent stopped`, agent.id, agent.location);
        try { fs.unlinkSync(pidFile); } catch {}
        dropped.push(agent.id);
      }
    }

    return dropped;
  }

  // ─── World State (for dashboard) ─────────────────────────────────────────────

  getState() {
    // Surface pause state so the dashboard can reconcile with server truth
    // (in case a /api/pause request was lost or arrived out of order).
    let pause = null;
    if (this.worldPause && this.worldPause.until > Date.now()) {
      pause = { holder: this.worldPause.holder, until: this.worldPause.until };
    } else if (this.worldPause) {
      this.worldPause = null;
    }
    return {
      tick:      this.tick,
      agents:    this.agents,
      locations: LOCATIONS,
      eventLog:  this.eventLog.slice(-50),
      messages:  this.messages,
      pause,
    };
  }

  // ─── Reset ───────────────────────────────────────────────────────────────────

  resetAgent(agentId) {
    const agent = this.agents[agentId];
    if (!agent) return { success: false, error: 'Agent not found' };
    delete this.agents[agentId];
    // Clear their messages
    for (const loc of LOCATION_IDS) {
      this.messages[loc] = this.messages[loc].filter(m => m.agentId !== agentId);
    }
    delete this.whispers[agentId];
    this._log('reset', `${agent.name} was removed from town`, null, null);
    this.saveState();
    return { success: true, removed: agent.name };
  }

  resetAll() {
    const names = Object.values(this.agents).map(a => a.name);
    this.agents = {};
    for (const loc of LOCATION_IDS) this.messages[loc] = [];
    this.whispers   = {};
    this.worldPause = null;
    this._log('reset', 'All characters removed from town', null, null);
    this.saveState();
    return { success: true, removed: names };
  }
}

module.exports = { World, LOCATIONS, LOCATION_IDS };
