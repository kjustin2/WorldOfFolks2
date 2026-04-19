# WorldOfFolks 2 — CLAUDE.md

## Project Overview

WorldOfFolks 2 is a Node.js narrative simulation where players create characters via freeform text, then watch (or participate as) those characters interact in a small town driven by AI agents. It is a spiritual sequel to WorldOfFolks (in `WorldofFolks/`), simplified to focus on character and dialogue.

## What This Game Is NOT

- Not an economy simulation (no crafting, gathering, trading, or market system)
- Not a politics simulator (no elections, laws, or reputation systems)
- Not a combat game (no dueling, weapons, or health)
- Not procedurally generated (player-authored characters, not preset archetypes)

## Key Differences from WoF1

| WoF1 | WoF2 |
|---|---|
| 16 preset characters | 2–8 player-created characters |
| Observer only | Observer + playable character |
| 13 locations | 7 locations |
| 20+ actions | 7 actions (move, speak, shout, whisper, think, remember, look) |
| Pre-written personality prompts | Prompts generated at runtime from player descriptions |
| No reset system | `/reset` and `/reset [name]` commands |
| No clarification flow | Creator asks follow-up questions when descriptions are vague |

## Tech Stack

- **Runtime**: Node.js (no build step, no transpilation)
- **Backend**: Express.js + `ws` WebSocket library
- **Frontend**: Vanilla HTML/CSS/JS (no frameworks)
- **Persistence**: JSON files in `characters/` + `world_state.json`
- **AI agents**: Child processes spawned by `launch.js` — supports `claude`, `ollama`, `antigravity`
- **Dependencies**: `express`, `ws` only (same as WoF1)

## Project Structure

```
WorldofFolks2/           (the new game — this repo root)
├── CLAUDE.md            (this file)
├── README.md
├── package.json
├── game.js              # Unified entry point — orchestrates server, creation, agents, player CLI
├── create-characters.js # Interactive character creation wizard (standalone or called by game.js)
├── launch.js            # Spawns AI agent terminal windows (standalone or called by game.js)
├── server/
│   ├── world.js         # World simulation (simplified from WoF1)
│   ├── index.js         # Express + WebSocket server
│   └── creator.js       # Character description parser + clarification engine
├── cli/
│   ├── town.js          # Agent action CLI (used by AI subprocesses)
│   └── player.js        # Human player CLI (standalone or called by game.js)
├── web/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── characters/          # Created character JSON files + world_state.json
WorldofFolks/            # WoF1 — reference only, do not modify
```

## Running the Game

```bash
# Single command — does everything
npm run play
```

`game.js` is intentionally tiny. It:
1. Checks that the Claude CLI is installed and reachable (`claude --version`)
2. Requires `server/index.js` inline (starts Express + WebSocket, binds to `PORT`)
3. Opens the default browser to `http://localhost:PORT` (`start`/`open`/`xdg-open`)

**Everything else — character creation, the continue/add-more/start-over menu,
picking who to play as, launching AI agents, playing, and reset — happens in the
browser UI (`web/app.js`).** No interactive terminal menus in `game.js`.

The browser's welcome-back screen (shown when characters exist but no agents are
running) offers three things:
- pick any character tile + `Launch the Town →` to start the game
- `+ Add more characters` to create additional characters before launching
- `New Game` button in the header to wipe everything and restart the wizard

Shutdown: `server/index.js` registers `SIGINT`/`SIGTERM`/`exit` handlers that call
`killAgentTerminals()` — on Windows this runs `taskkill /FI "WINDOWTITLE eq WorldOfFolks2: <name>" /T /F`
for each launched agent window. Pressing Ctrl+C in the `npm run play` terminal
closes the agent terminals and frees port 3000.

Individual steps can still be run separately for development:

```bash
npm run create    # Character creation only
npm start         # Server only
npm run launch    # AI agents only (server must already be running)
node cli/player.js  # Player CLI only
```

### MANAGED env var

When the server spawns `launch.js` via `POST /api/game/launch`, it sets `MANAGED=true`. This
suppresses the "To watch / npm run play" banner at the end of `launch.js` since the user is
already in the browser. `create-characters.js` also checks `MANAGED` for its own standalone
flow (the browser does not spawn it — kept for dev use).

## Character Creation System (`creator.js`)

The core new feature of WoF2. Flow:

1. Player types freeform description of a character
2. `creator.js` parses it into a structured `CharacterProfile`
3. If required fields are missing or vague, it generates targeted clarifying questions
4. Player answers in freeform; system re-parses
5. Loop until confident profile is complete
6. Profile is saved to `characters/[name].json`
7. `generatedPrompt` field is built from the profile and used to seed the AI agent

**Required profile fields** (must be confirmed before character is locked):
- `name`
- `role` (occupation or social role in town)
- `traits` (at least 2 personality traits)
- `wants` (what they're working toward or hoping for)
- `flaw` (a weakness, blind spot, or internal contradiction)

**Optional but enriching**:
- `backstory`
- `relationships` (named connections to other characters)
- `secret` (something they haven't told anyone)

## World Simulation (`world.js`)

Simplified from WoF1. Key systems retained:

- **Location tracking**: 7 named locations, agents have a current location
- **Conversation context**: When an agent speaks, nearby agents receive the message + speaker name. Direct address (name mentioned) flags the recipient for immediate response.
- **Movement**: Agents move between locations; location change is tracked and broadcast
- **Persistent memory**: `characters/memories/[name].txt` — agents can write to this, it's injected back on restart
- **World state persistence**: `characters/world_state.json` — saved every 60 seconds

Systems removed vs WoF1:
- No economy/market/pricing
- No hunger/energy/mood meters
- No crafting or inventory
- No elections or laws
- No random world events (dragon attacks, mermaid, etc.)
- No achievements or titles

## Reset System

Reset commands are handled in both the player CLI and via the web dashboard:

- `reset` — clear all characters, return to creation flow, wipe world state
- `reset [name]` — clear one character, re-run creation for that character, keep others running
- `reset [name] --keep-history` — rebuild character profile but preserve their memory file and location
- `reset --soft` — clear AI session state only, keep profiles and world state intact

On reset of a single character:
1. Kill the AI subprocess for that character
2. Delete `characters/[name].json`
3. Optionally delete `characters/memories/[name].txt`
4. Run the creation flow again for that slot
5. Relaunch the AI subprocess with the new profile

## Player Character System (`player.js`)

The player can inhabit one character. This character is NOT driven by an AI agent — it's driven by keyboard input via the player CLI.

Player commands map directly to the same action API used by AI agents:
- `go [location]` → `move` action
- `say [text]` → `speak` action
- `whisper [name] [text]` → `speak` action with direct address
- `look` → read current location state
- `status` → read player character state
- `/observe` → detach from character, return to observer mode
- `/play [name]` → attach to a character

The player's speech is passed into the world identically to AI agent speech. NPCs respond using the same conversation context mechanism — they see the message, who said it, whether they were named.

## Dialogue Architecture (inherited from WoF1)

When an agent `speak`s at a location:
1. Message is written to `recentMessages` for that location (last 8, last 60 ticks)
2. All agents at that location receive `conversationContext` on next tick
3. If the speaking message contains another agent's name, that agent gets `directlyAddressed: true`
4. Directly addressed agents must respond before any other action
5. Agents speak in 1–3 sentences max per turn

The AI prompt always includes:
- Who spoke recently at this location
- Whether this agent was directly addressed
- Who else is currently here
- What they want, believe, and remember

## AI Agent Prompt Structure (generated at runtime)

Unlike WoF1 (hardcoded prompts), WoF2 prompts are assembled from `CharacterProfile`:

```
You are [name], [role] in a small town.

[personality traits block]

[backstory block if present]

You want: [wants]
Your flaw: [flaw]
[secret block if present]

[relationships block if present]

CONVERSATION RULES:
- You MUST respond whenever someone speaks near you.
- 1–3 sentences per speak. One idea. Wait for reply before your next point.
- If someone uses your name, respond to them directly first.
- Speak as yourself. Not a narrator. Not a description. Your actual words.

[prior memories if any]
```

## Development Notes

- Reference WoF1 code in `WorldofFolks/` for patterns — especially `world.js` (location/agent state), `cli/town.js` (action dispatch), and `web/app.js` (WebSocket rendering)
- Do not copy WoF1 systems wholesale — the goal is a simpler foundation, not a port
- The creator.js clarification engine is the most novel piece — it should feel like a conversation, not a form
- Player character parity: player actions must go through the same action API as AI agents, no special cases
- Keep dependencies at `express` + `ws` only unless there is a strong reason to add more

## Locations Reference

| ID | Display Name | Notes |
|---|---|---|
| `square` | Town Square | Central hub, high foot traffic |
| `tavern` | Tavern | Social gathering place |
| `market` | Market | Transactions, haggling |
| `park` | Park | Quiet, private conversations |
| `blacksmith` | Blacksmith | Working noise, few visitors |
| `library` | Library | Knowledge, old records |
| `docks` | Docks | Endings, departures, distance |

## Agent Action Set

| Action | Params | Effect |
|---|---|---|
| `look` | — | Return the current location, who is there, and recent speech |
| `move` | `location` | Change current location |
| `speak` | `message` | Broadcast to current location |
| `shout` | `message` | Broadcast to entire town |
| `whisper` | `target`, `message` | Private message — only to someone at the same location |
| `think` | `thought` | Log internal thought (not visible to others) |
| `remember` | `text` | Write to persistent memory file |

### Whisper rules
- Target must be `active` and at the **same location** as the sender.
- Cannot whisper to yourself.
- The log entry includes the full text: `Alice whispered to Bob: "your secret is safe"`.
  This is intentional so the dashboard can show the content; whispers are NOT filtered from
  the event feed. The private-vs-public split is that only the target's `look` surfaces the
  whisper in the `whispers` array (and the dashboard shows it, since it's a local observer
  tool, not a multiplayer server).
