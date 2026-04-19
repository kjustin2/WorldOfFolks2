# WorldOfFolks 2

Build a cast of characters in plain English. Watch them live in a small town — or step in and play as one of them.

## Quick Start

```bash
npm install
npm run play
```

Requires the [Claude CLI](https://claude.ai/code). The game checks for it and tells you if it's missing.

`npm run play` starts the server and opens your browser to **http://localhost:3000**. Everything — character creation, adding more characters, choosing who to play as, playing, resetting — happens in the browser.

Leave the terminal window open while you play. Press **Ctrl+C** in it when you're done to shut the town down (this also closes the AI agent windows and frees port 3000).

## In the browser

- **First run** — describe 2–8 characters in plain English. The game asks follow-up questions if anything is vague.
- **Welcome back** (characters already exist) — pick one to play as (or "Just Watch"), hit **Launch the Town →**. Or click **+ Add more characters** to expand the cast first.
- **Any time** — the **New Game** button in the header wipes everything and restarts the wizard.

Once the town is open, you get a map, a conversation feed, and a panel with **Say**, **Whisper** (to someone at your location), **Move**, and **Look around**.

## Troubleshooting

**Port 3000 already in use** — find and kill the holder (Command Prompt, not Git Bash):

```
netstat -ano | findstr :3000
taskkill /PID <number> /F
```

Or pick another port: `PORT=3001 npm run play`.

**Claude CLI not found** — install from https://claude.ai/code, run `claude` once to log in, then retry.
