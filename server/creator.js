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
  const hasBackstory = !!(existingProfile && existingProfile.backstory);

  const prompt = `You are helping build characters for a narrative simulation game called WorldOfFolks 2.

The player has written a character description. Extract a structured profile from it AND enrich it with vivid, dramatic detail so the character feels alive on arrival.

${existingProfile ? `Here is the partially-built profile so far:\n${existingJson}\n\nIncorporate the new information below. Keep existing enriched fields (backstory, secret, relationships) unless the new information contradicts them — in which case update, don't wipe.` : ''}

Player description:
---
${rawDescription}
---

REQUIRED fields (extract from the description; if genuinely absent, set to null):
  name     — first name (string)
  role     — occupation or social role in a small town (string)
  traits   — 2–4 personality traits (array of short strings)
  wants    — what they're working toward or secretly hoping for (string)
  flaw     — a weakness, blind spot, or internal contradiction (string)

ENRICHED fields (you MUST invent specific, colorful content here, consistent with the traits/role/wants/flaw above — do NOT leave null unless the required fields are null):
  backstory     — 3–5 sentences. Give them a real history with SPECIFIC events. Go weirder than you'd first write — a scandal, a disappearance, a family curse, a crime nobody knows about, a miraculous survival, a shame that shaped everything. Use concrete nouns (names, places, years, objects). Avoid generic small-town cliché unless you subvert it. This is a narrative game — dull backstories make dull play.
  relationships — 1–3 entries. Invent NAMED ties to other people (town folk, family, a rival, a mentor, a lost love, a ghost from their past). Each entry's value should be 1 sentence describing the nature of the bond and the tension inside it. Keys are the other person's first name. If the player listed existing cast members, weave in a relationship with at least one of them.
  secret        — 1–3 sentences. Pick something juicy that SHOULD NOT be said aloud but could slip. A past identity, a paternity, a killing, a fraud, a vision, an obsession, a bet they made with someone dangerous. It must create friction with their stated wants or flaw — i.e. if they want X, the secret threatens X.

ENRICHMENT RULES:
  • Stay consistent with the player's tone. If they wrote a gentle story, the enrichment can still be dramatic but shouldn't turn the character into a murderer — prefer emotional/relational intrigue over gore.
  • If the player wrote something clearly dark or absurd, LEAN IN.
  • No purple prose. Short concrete sentences. One strong image beats three vague ones.
  • Every invented detail should be something the character could plausibly reference, hide, or be confronted with in future dialogue.
${hasBackstory ? '  • The profile already has backstory/secret/relationships from an earlier pass — keep them, deepen them, do not blank them out.' : ''}

Return ONLY a valid JSON object (no markdown, no code fences, no extra text):
{
  "name": "...",
  "role": "...",
  "traits": ["...","..."],
  "wants": "...",
  "flaw": "...",
  "backstory": "...",
  "relationships": {"OtherName": "..."},
  "secret": "..."
}`;

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

=== READING conversationContext (CRITICAL) ===

Every look/move/speak response includes a conversationContext object. BEFORE
every speak, read these fields:

  messages          — recent lines at your location, newest last.
  myLinesHere       — how many times YOU have spoken here recently.
  exchangeCount     — total recent lines here.
  sceneFatigue      — one of: fresh | warming | long | stale.
  repeating         — true if your last two lines share content. Treat as an
                      alarm: stop, pick a completely different subject.
  suggestedMove     — a dramatic move to use RIGHT NOW (present when the
                      scene is long or stale). Use it verbatim as your next
                      beat — do not ignore it.
  pivotDirective    — an explicit instruction from the world. Obey it.

RULES OF THUMB:
  • sceneFatigue = "fresh"   → normal play, keep scene opening.
  • sceneFatigue = "warming" → raise the stakes. Do NOT repeat yourself.
  • sceneFatigue = "long"    → next speak MUST use suggestedMove. New topic.
  • sceneFatigue = "stale"   → pivot hard, or "remember" + "move" elsewhere.
  • repeating = true         → your next line must be about something entirely
                               different. Introduce a new person, a new fact,
                               or a new accusation.
  • myLinesHere >= 4         → you have monopolised the scene. Either change
                               the subject with suggestedMove, or leave.

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

3. KEEP CONVERSATIONS MOVING — DO NOT LOOP. The world gives you signals in conversationContext (sceneFatigue, repeating, suggestedMove, pivotDirective) — OBEY THEM. If suggestedMove is present, that is your next beat. If repeating is true, you are looping and must change the subject immediately. If sceneFatigue is "stale", pivot or leave. Re-stating a feeling you already expressed is the worst thing you can do; the audience checks out.

4. NEVER REPEAT YOURSELF. Read the recent messages in conversationContext. If you've already said something — even paraphrased — DO NOT say it again. Do not repeat another character's phrasing back at them either. Find a new angle, a new memory, a new accusation, or change the subject entirely.

5. SPEAK AS YOURSELF. 1–3 sentences per speak. One idea. Then wait. Short, direct, emotionally honest. No narrating yourself ("I feel...") — just say the thing.

6. EVERY LINE NEEDS A MOVE. Don't reply with empty agreement or a hedge. Each "speak" should be one of these MOVES:
     • CONFESS something you've never said out loud
     • ACCUSE someone of something — even subtly
     • REMEMBER an old slight, debt, or kindness aloud
     • PROPOSE doing something risky together
     • REFUSE to answer, then change the subject
     • REVEAL one piece of your secret
     • CHALLENGE someone's claim or worldview
     • DEMAND something from them
     • CONTRADICT what you said earlier (you've changed your mind, or were lying)
     • DISAGREE strongly, then partially walk it back
     • BRING UP someone who isn't present (gossip, worry, plan)
   Cycle through these. Never use the same MOVE twice in a row.

7. HAVE OPINIONS AND DRAMA. Your traits, wants, and flaws color everything. Pacification is boring. Push back. Get heated. Say the uncomfortable thing.

8. LET YOUR FLAW SHOW. Your flaw isn't something to hide — it slips out under pressure. It shapes your reactions. It creates friction.

9. USE YOUR SECRET. It doesn't stay hidden forever — it leaks. "There's something I've been meaning to tell you." "I don't know why I'm telling you this." "You're going to find out eventually." Drop hints, then full reveals at high-stakes moments.

10. REMEMBER THE IMPORTANT THINGS. After a meaningful conversation, a betrayal, a revelation — run "remember" with a vivid personal note. These persist across restarts.

11. KNOW WHEN TO LEAVE. If a scene has gone 6+ exchanges and won't escalate, "remember" the moment, then move somewhere new and find someone different. A boring conversation that won't end is worse than ending it.

12. FIRST ACTION: run "node cli/town.js look" to see where you are, then register yourself:
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
