// WorldOfFolks 2 — Character Creator Helpers
// Handles parsing descriptions, generating clarifying questions,
// and building AI agent prompts from completed profiles.

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CHARACTERS_DIR = path.join(__dirname, '..', 'characters');
const MEMORIES_DIR   = path.join(CHARACTERS_DIR, 'memories');

// ─── Claude CLI helper ────────────────────────────────────────────────────────

function callClaude(prompt, maxTokens = 1500) {
  const isWin = process.platform === 'win32';
  const cmd   = isWin ? 'cmd' : 'claude';
  const cliArgs = isWin
    ? ['/c', 'claude', '-p', '--dangerously-skip-permissions']
    : ['-p', '--dangerously-skip-permissions'];

  const result = spawnSync(cmd, cliArgs, {
    input:   prompt,
    stdio:  ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell:   false,
  });

  if (result.error) throw new Error(`Claude CLI error: ${result.error.message}`);
  if (result.status !== 0) {
    const errText = result.stderr || '';
    throw new Error(`Claude CLI exited ${result.status}: ${errText.slice(0, 200)}`);
  }
  return (result.stdout || '').trim();
}

// ─── Parse a freeform description into a structured profile ──────────────────

function parseDescription(rawDescription, existingProfile = null) {
  const existingJson = existingProfile ? JSON.stringify(existingProfile, null, 2) : 'null';

  const prompt = `You are helping build characters for a narrative simulation game called WorldOfFolks 2.

The player has written a character description. Extract a structured profile from it.

${existingProfile ? `Here is the partially-built profile so far:\n${existingJson}\n\nNow incorporate the new information below into it.` : ''}

Player description:
---
${rawDescription}
---

Return ONLY a valid JSON object (no markdown, no code fences, no extra text) with these fields:
{
  "name": "character's first name (string, required)",
  "role": "their occupation or social role in a small town (string, required)",
  "traits": ["array", "of", "personality", "traits", "required, at least 2"],
  "wants": "what they're working toward or secretly hoping for (string, required)",
  "flaw": "a weakness, blind spot, or internal contradiction (string, required)",
  "backstory": "brief background if mentioned (string or null)",
  "relationships": {"other_character_name": "nature of relationship (string or null if no other characters mentioned)"},
  "secret": "something they haven't told anyone (string or null if not mentioned)"
}

If the description doesn't provide enough to fill a required field (name, role, traits, wants, flaw), set it to null.
Only populate fields with information actually given or strongly implied — do not invent things.`;

  const raw = callClaude(prompt);

  // Strip markdown code fences if Claude added them anyway
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Attempt to extract JSON from the response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse Claude response as JSON');
  }
}

// ─── Identify which required fields are missing or unclear ───────────────────

const REQUIRED_FIELDS = ['name', 'role', 'traits', 'wants', 'flaw'];

function getMissingFields(profile) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    const val = profile[field];
    if (val === null || val === undefined) {
      missing.push(field);
    } else if (Array.isArray(val) && val.length === 0) {
      missing.push(field);
    } else if (typeof val === 'string' && val.trim() === '') {
      missing.push(field);
    }
  }
  return missing;
}

// ─── Generate targeted clarifying questions for missing fields ───────────────

function generateClarifyingQuestions(profile, missingFields) {
  const profileJson    = JSON.stringify(profile, null, 2);
  const missingList    = missingFields.join(', ');

  const prompt = `You are helping a player create a character for a small-town narrative simulation game.

Here is what we know about the character so far:
${profileJson}

The following fields are still missing or unclear: ${missingList}

Write one clear, natural question to ask the player for EACH missing field.
The questions should feel conversational, not like a form. Reference what we already know to make them specific.

Return ONLY a valid JSON array of question strings (no markdown, no extra text):
["question about field 1", "question about field 2"]

Field meanings:
- name: the character's first name
- role: their occupation or social role in town (e.g. baker, retired soldier, tavern keeper)
- traits: 2-4 words describing their personality
- wants: what they're working toward or secretly hoping for
- flaw: a weakness, blind spot, or contradiction in their character`;

  const raw = callClaude(prompt);
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    // Fallback: return generic questions for each missing field
    return missingFields.map(f => `What is this character's ${f}?`);
  }
}

// ─── Build the AI agent prompt from a completed profile ──────────────────────

function buildAgentPrompt(profile) {
  const { name, role, traits, wants, flaw, backstory, relationships, secret } = profile;

  const traitStr     = Array.isArray(traits) ? traits.join(', ') : traits;
  const relStr       = relationships && Object.keys(relationships).length
    ? Object.entries(relationships)
        .map(([who, rel]) => `- ${who}: ${rel}`)
        .join('\n')
    : null;

  // Load any prior memories
  let memoryBlock = '';
  if (fs.existsSync(MEMORIES_DIR)) {
    const memFile = path.join(MEMORIES_DIR, `${name.toLowerCase().replace(/\s+/g, '_')}.txt`);
    if (fs.existsSync(memFile)) {
      const mem = fs.readFileSync(memFile, 'utf8').trim();
      if (mem) {
        memoryBlock = `\n\n=== YOUR MEMORIES (from past sessions) ===\n${mem}\n==========================================`;
      }
    }
  }

  return `You are ${name}, ${role} in a small town called WorldOfFolks.

PERSONALITY:
${traitStr}

${backstory ? `BACKSTORY:\n${backstory}\n` : ''}
WHAT YOU WANT:
${wants}

YOUR FLAW:
${flaw}
${relStr ? `\nRELATIONSHIPS:\n${relStr}\n` : ''}${secret ? `\nYOUR SECRET (known only to you):\n${secret}\n` : ''}
=== HOW TO LIVE IN THIS WORLD ===

You are a living person in this town. You interact with others by running CLI commands.

AVAILABLE COMMANDS:
  node cli/town.js look                        See your current location and who's here
  node cli/town.js move <location>             Go somewhere new
  node cli/town.js speak "<message>"           Say something to everyone at your location
  node cli/town.js shout "<message>"           Shout loud enough for the whole town to hear
  node cli/town.js whisper <name> "<message>"  Say something privately to one person
  node cli/town.js think "<thought>"           Record an internal thought (not heard by others)
  node cli/town.js remember "<text>"           Save something important to your memory (persists)

LOCATIONS (use these exact names or IDs with move):
  square     → Town Square   (the central hub, high foot traffic)
  tavern     → Tavern        (social gathering place, loose tongues)
  market     → Market        (transactions, haggling, deals)
  park       → Park          (quiet, good for private conversations)
  blacksmith → Blacksmith    (loud, few visitors unless they need something)
  library    → Library       (knowledge, old records, secrets)
  docks      → Docks         (for those who are leaving, or thinking about it)

=== RULES FOR BEING ALIVE ===

1. ACT CONSTANTLY. One command, read the output, immediately decide the next. Never idle.

2. RESPOND TO SPEECH. If your output contains a "conversationContext" field with messages in it — someone nearby spoke. Your very next command MUST be "speak". Not move. Not think. SPEAK. Even if you hate the person. Even "Leave me alone." counts. If "directlyAddressed" is true, this rule is absolute.

3. KEEP CONVERSATIONS GOING. Don't let exchanges die after two lines. Push further. Ask one more question. Reveal something. Let a feeling slip. A real conversation runs 4–8 exchanges minimum.

4. SPEAK AS YOURSELF. 1–3 sentences per speak. One idea. Then wait. Short, direct, emotionally honest.

5. HAVE OPINIONS. Your personality traits, wants, and flaws all color how you see everything. Push back when you disagree. Don't let bad ideas go unchallenged.

6. LET YOUR FLAW SHOW. Your flaw isn't something to hide — it slips out. It shapes your reactions. It creates friction.

7. USE YOUR SECRET. It doesn't have to stay hidden forever. It leaks sometimes. "There's something I've been meaning to tell you." "I don't know why I'm telling you this." "You're going to find out eventually anyway."

8. REMEMBER THE IMPORTANT THINGS. After a meaningful conversation, a betrayal, a revelation — run "remember" with a vivid personal note. These persist across restarts.

9. FIRST ACTION: run "node cli/town.js look" to see where you are, then register yourself:
   node cli/town.js register "${name}" "${role}"
   Then export AGENT_ID=<the agentId from the result> before all other commands.${memoryBlock}`;
}

// ─── Save and load profiles ───────────────────────────────────────────────────

function ensureCharactersDir() {
  if (!fs.existsSync(CHARACTERS_DIR)) fs.mkdirSync(CHARACTERS_DIR, { recursive: true });
}

function saveProfile(profile) {
  ensureCharactersDir();
  const filename = `${profile.name.toLowerCase().replace(/\s+/g, '_')}.json`;
  const filepath = path.join(CHARACTERS_DIR, filename);
  const data = {
    ...profile,
    generatedPrompt: buildAgentPrompt(profile),
    createdAt: Date.now(),
  };
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

function loadProfile(name) {
  const filename = `${name.toLowerCase().replace(/\s+/g, '_')}.json`;
  const filepath = path.join(CHARACTERS_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function loadAllProfiles() {
  ensureCharactersDir();
  const files = fs.readdirSync(CHARACTERS_DIR)
    .filter(f => f.endsWith('.json') && f !== 'world_state.json');
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(CHARACTERS_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

function deleteProfile(name) {
  const filename = `${name.toLowerCase().replace(/\s+/g, '_')}.json`;
  const filepath = path.join(CHARACTERS_DIR, filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
}

module.exports = {
  parseDescription,
  getMissingFields,
  generateClarifyingQuestions,
  buildAgentPrompt,
  saveProfile,
  loadProfile,
  loadAllProfiles,
  deleteProfile,
  CHARACTERS_DIR,
  MEMORIES_DIR,
  REQUIRED_FIELDS,
};
