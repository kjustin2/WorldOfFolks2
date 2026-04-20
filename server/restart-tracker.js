// Throttle for agent auto-restarts. Prevents an infinite restart loop when
// an agent dies/stalls repeatedly (e.g. invalid prompt, missing API key).
//
// `attempt(id)` records a restart for `id` and returns true if it's allowed,
// false if the agent has already burned through `limit` restarts inside the
// trailing `windowMs`. `now` is injectable so tests can advance the clock.

class RestartTracker {
  constructor({ windowMs = 5 * 60_000, limit = 3, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.limit    = limit;
    this.now      = now;
    this.history  = {}; // agentId -> [timestamps within the window]
  }

  attempt(agentId) {
    const t = this.now();
    const fresh = (this.history[agentId] || []).filter(ts => t - ts < this.windowMs);
    if (fresh.length >= this.limit) {
      this.history[agentId] = fresh; // keep so countInWindow stays accurate
      return false;
    }
    fresh.push(t);
    this.history[agentId] = fresh;
    return true;
  }

  countInWindow(agentId) {
    const t = this.now();
    return (this.history[agentId] || []).filter(ts => t - ts < this.windowMs).length;
  }

  reset(agentId) {
    if (agentId) delete this.history[agentId];
    else this.history = {};
  }
}

module.exports = { RestartTracker };
