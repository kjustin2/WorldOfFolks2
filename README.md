# WorldOfFolks 2

An interactive narrative simulation where **you build the cast** — then step inside the story.

WorldOfFolks 2 strips the first game down to its most compelling core: the characters. The economy, crafting, politics, and elaborate event systems are gone. What remains is a small town, a handful of people with rich inner lives, and the conversations that happen between them. You create every character from scratch using plain language. Then you watch — or become one of them.

---

## What's New in 2

| Feature | WoF1 | WoF2 |
|---|---|---|
| Character creation | Pre-defined cast of 16 | You create every character |
| Player role | Observer only | Observer **or** playable character |
| World complexity | 13 locations, economy, crafting, politics | 7 locations, focused on dialogue |
| Cast size | Fixed at 16 | 2–8 characters (your choice) |
| Reset system | Restart the whole server | Reset any character or all characters mid-game |
| Clarification system | None | Asks follow-up questions when descriptions are vague |

---

## Core Loop

1. **Create your characters.** Describe each one in your own words.
2. **Confirm or refine.** The system extracts a profile and asks for clarification on anything unclear.
3. **Choose your role.** Watch the town unfold, or step in as one of your characters.
4. **Let it run.** AI agents bring your characters to life. They move, talk, react, remember.
5. **Intervene freely.** Speak as your character. NPCs hear you and respond in their voice.
6. **Reset anytime.** Rebuild one character or wipe the slate and start over.

---

## Character Creation

When the game starts, it walks you through creating each character one at a time.

### How it works

You type a freeform description. Any length, any style. For example:

> *"A middle-aged woman named Ruth who runs the tavern. She's been in this town her whole life and knows everyone's secrets. She's warm but blunt — she'll tell you what she thinks whether you want to hear it or not. She has a complicated history with the blacksmith."*

The system parses this into a character profile:
- **Name**: Ruth
- **Role**: Tavern keeper
- **Personality traits**: warm, blunt, direct, knowledgeable
- **Backstory hooks**: lifelong local, keeper of secrets
- **Relationship seeds**: complicated history with the blacksmith

If your description is vague or missing key details, the game asks targeted follow-up questions:

> *"What's Ruth's biggest flaw or blind spot?"*
> *"Does she want anything — something she's working toward or secretly hoping for?"*
> *"You mentioned a complicated history with the blacksmith. Is that a rivalry, an old romance, a debt, or something else?"*

You answer in freeform text. The system keeps asking until it has enough to build a full, playable character.

Once confirmed, the profile is locked in and the AI prompt is generated. You move on to the next character.

### Character limits

- Minimum: 2 characters
- Maximum: 8 characters
- Recommended: 3–5 for a good balance of activity and readability

### What makes a good description

- **Specificity beats length.** "She distrusts anyone who smiles too much" is more useful than two paragraphs of backstory.
- **Contradictions are great.** A coward who is also fiercely protective. A generous person who steals small things.
- **Relationships are the engine.** Even a hint of connection between two characters creates drama automatically.

---

## Resetting Characters

### Reset all characters

```
reset
```

Clears all characters. Returns to the character creation flow. World state (location history, in-progress conversations) is also cleared.

### Reset one character

```
reset [name]
```

Examples:
```
reset Ruth
reset the blacksmith
```

Clears that character's profile and AI state. Walks you through creating them again from scratch. All other characters continue running. The new version of the character enters the world when creation is complete.

### Reset flags

```
reset Ruth --keep-history     # Rebuild the character but keep their location/memory
reset --soft                  # Re-roll AI state only, keep profiles and world state
```

---

## The World

WorldOfFolks 2 takes place in a small, unnamed town with seven locations. The world is simple by design — the drama comes from the people, not the systems.

### Locations

| Location | Description | Why Go Here |
|---|---|---|
| **Town Square** | The central hub. Benches, a notice board, foot traffic. | Everyone passes through. Best place to overhear or be overheard. |
| **Tavern** | Dim, warm, loud by evening. Ruth pours drinks. | Gathering place. Loosens tongues. |
| **Market** | Stalls, haggling, transactions. | Where deals happen, debts get called in. |
| **Park** | Quiet paths, a pond, a bench under an old tree. | For thinking, for private conversations, for avoiding someone. |
| **Blacksmith** | Loud, hot, always working. | Where the town's muscle lives. Not many visit unless they need something. |
| **Library** | Small but old. Half the books are catalogued. | The scholar's domain. Secrets live in old records. |
| **Docks** | End of the main road. Boats, water, distance. | People come here when they're leaving, or thinking about it. |

Characters move freely between locations on their own schedule. They show up where it makes sense for who they are.

---

## Playing as a Character

After creating your cast, you can choose to inhabit one of them.

### Choosing your character

At the start you'll be asked:

```
Would you like to play as one of your characters, or just watch?

[1] Watch (observer mode)
[2] Play as Ruth
[3] Play as the blacksmith
...
```

You can switch modes later with:

```
/observe     # step back to observer
/play Ruth   # step into a character
```

### Commands in player mode

```
go [location]            # Move to a location
say [text]               # Speak aloud at your current location
whisper [name] [text]    # Speak directly to one person
look                     # See who's here and recent activity
status                   # Your character's current state
/observe                 # Stop playing, return to observer mode
```

### How dialogue works

When you `say` something, every character at your location hears it. They respond the same way they respond to each other — according to their personality, their current mood, their history with you, and whether they were directly addressed.

If you say someone's name, they are flagged as directly addressed and will respond to you specifically before taking any other action. If you speak generally, whoever feels most inclined to respond will.

Example:

```
> say "Has anyone seen the blacksmith today? He owes me an answer."

[Ruth] — leans on the bar — "He was here at noon. Left in a hurry. Didn't say where."
[Thomas] — looks up from his drink — "I wouldn't go looking if I were you. Not today."
```

You're not playing as an AI agent. Your words are taken literally and passed directly into the conversation context. The NPCs don't know you're human.

---

## Observer Mode

If you choose not to play as a character, or after stepping out with `/observe`, you watch the town from above.

The web dashboard at `http://localhost:3000` shows:
- **Town map**: Where each character currently is
- **Live event feed**: Every action, speech, and movement in real time
- **Character cards**: Name, current location, mood, and recent dialogue
- **Conversation threads**: Ongoing exchanges grouped by location

You can also type commands from observer mode to nudge the world:

```
/shout [text]           # Anonymous message heard by everyone in town (use sparingly)
/time fast              # Speed up the simulation
/time normal            # Return to normal speed
```

---

## Architecture

WorldOfFolks 2 uses the same lightweight stack as the original:

- **Backend**: Node.js + Express + WebSocket (`ws`)
- **Frontend**: Vanilla HTML/CSS/JS
- **AI agents**: Spawned as child processes via `launch.js`
- **Persistence**: `world_state.json` + per-character memory files

### Key files

```
WorldofFolks2/
├── create-characters.js     # Interactive CLI: character creation flow
├── launch.js                # Spawns AI agents for all created characters
├── server/
│   ├── world.js             # World simulation engine (simplified)
│   ├── index.js             # HTTP + WebSocket server
│   └── creator.js           # Character profile parser + clarification logic
├── cli/
│   ├── town.js              # Agent CLI (used by AI agents)
│   └── player.js            # Player character CLI interface
├── web/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── characters/              # Generated character profiles (JSON)
    └── world_state.json
```

### Character profile format

Each created character is stored as a JSON file in `characters/`:

```json
{
  "id": "ruth",
  "name": "Ruth",
  "role": "Tavern keeper",
  "rawDescription": "A middle-aged woman who runs the tavern...",
  "traits": ["warm", "blunt", "observant", "keeper of secrets"],
  "backstory": "Has lived in this town her whole life. Knows everyone.",
  "wants": "For the town to stay as it is. Doesn't trust change.",
  "flaw": "Tells herself she's neutral when she's actually been picking sides for years.",
  "relationships": {
    "blacksmith": "complicated history — details TBD from player"
  },
  "generatedPrompt": "..."
}
```

### AI agent support

WorldOfFolks 2 supports the same AI backends as WoF1:

```bash
AGENT_SYSTEM=claude npm run launch
AGENT_SYSTEM=ollama AGENT_MODEL=llama3 npm run launch
AGENT_SYSTEM=antigravity AGENT_MODEL=gemini-3.0-flash npm run launch
```

---

## Getting Started

```bash
# Install dependencies
npm install

# Create your characters
npm run create

# Launch the simulation (in a second terminal)
npm run launch

# Open the dashboard
open http://localhost:3000
```

To play as a character instead of watching:

```bash
npm run play
```

---

## Simplified Action Set

WoF1 had 20+ actions. WoF2 has 7:

| Action | Description |
|---|---|
| `move [location]` | Go to a location |
| `speak [text]` | Say something at current location |
| `shout [text]` | Broadcast to entire town |
| `approach [name]` | Move into a private conversation |
| `leave` | End a conversation, step back |
| `think [text]` | Internal thought (logged but not spoken) |
| `remember [text]` | Save something to persistent memory |

No gathering, crafting, trading, dueling, praying, or economy. Just people and talk.

---

## Design Philosophy

**Characters first.** Everything in this game exists to make the characters feel real. The world is small because smaller worlds mean more collisions. The actions are limited because constraints force interesting choices. The creation system is detailed because the quality of what comes out depends entirely on the quality of what goes in.

**You made them.** Because you created each character, you understand them. You know why Ruth and the blacksmith have history. You know what Thomas is afraid of. Watching your own characters interact — surprising you, contradicting each other, revealing things you didn't plan — is the whole point.

**No winning.** There is no objective. There is no score. You're watching a town full of people you invented live their lives. That's the game.
