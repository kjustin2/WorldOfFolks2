#!/usr/bin/env node
'use strict';

// WorldOfFolks 2 — launcher
// Starts the server inline and opens the browser. Everything else (character
// creation, picking who to play as, adding more characters, starting over) is
// handled in the browser UI. Ctrl+C in this window shuts the town down
// (server's SIGINT handler also closes the AI agent terminals it spawned).

const { execSync, exec } = require('child_process');

const R    = '\x1b[0m';
const CYAN = '\x1b[36m';
const GRN  = '\x1b[32m';
const RED  = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM  = '\x1b[2m';

const PORT = process.env.PORT || 3000;
const URL  = `http://localhost:${PORT}`;

// ── Claude CLI check ──────────────────────────────────────────────────────────
try {
  execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
  console.log(`${GRN}✓${R} Claude CLI found`);
} catch {
  console.log(`\n${RED}WorldOfFolks 2 requires the Claude CLI.${R}`);
  console.log(`  Get it at: ${CYAN}https://claude.ai/code${R}`);
  console.log(`  After installing, run ${BOLD}npm run play${R} again.\n`);
  process.exit(1);
}

console.log(`\n${CYAN}${BOLD}WorldOfFolks 2${R}`);
console.log(`${DIM}Everything happens in the browser at ${URL}${R}`);
console.log(`${DIM}(Ctrl+C in this window to shut the town down.)${R}\n`);

// ── Start the server (inline) ─────────────────────────────────────────────────
// server/index.js registers its own SIGINT/SIGTERM/exit handlers that close
// the AI agent terminal windows it spawned, so we don't need to duplicate that.
require('./server/index.js');

// ── Open default browser after the server has a moment to bind ────────────────
setTimeout(() => {
  const cmd =
    process.platform === 'win32' ? `start "" "${URL}"` :
    process.platform === 'darwin' ? `open "${URL}"` :
    `xdg-open "${URL}"`;
  exec(cmd, () => {});
}, 800);
