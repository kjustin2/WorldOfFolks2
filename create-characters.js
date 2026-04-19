#!/usr/bin/env node
// WorldOfFolks 2 — Character Creation Wizard
// Run: npm run create

const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const {
  parseDescription,
  getMissingFields,
  generateClarifyingQuestions,
  saveProfile,
  loadAllProfiles,
  deleteProfile,
  CHARACTERS_DIR,
} = require('./server/creator');

// ─── Terminal helpers ─────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW= '\x1b[33m';
const RED   = '\x1b[31m';
const BLUE  = '\x1b[34m';

function c(color, text) { return `${color}${text}${RESET}`; }
function bold(t)   { return c(BOLD, t); }
function dim(t)    { return c(DIM, t); }
function cyan(t)   { return c(CYAN, t); }
function green(t)  { return c(GREEN, t); }
function yellow(t) { return c(YELLOW, t); }
function red(t)    { return c(RED, t); }
function blue(t)   { return c(BLUE, t); }

function printBanner() {
  console.log(`
${cyan('╔══════════════════════════════════════════════════╗')}
${cyan('║')}         ${bold('WorldOfFolks 2 — Character Creator')}         ${cyan('║')}
${cyan('╚══════════════════════════════════════════════════╝')}
`);
}

function printProfile(profile, index) {
  const num = index !== undefined ? ` ${index + 1}` : '';
  console.log(`\n${cyan('┌─── Character' + num + ' ──────────────────────────────────────┐')}`);
  console.log(`${cyan('│')} ${bold('Name:')}         ${profile.name || dim('(not set)')}`);
  console.log(`${cyan('│')} ${bold('Role:')}         ${profile.role || dim('(not set)')}`);
  console.log(`${cyan('│')} ${bold('Traits:')}       ${Array.isArray(profile.traits) ? profile.traits.join(', ') : (profile.traits || dim('(not set)'))}`);
  console.log(`${cyan('│')} ${bold('Wants:')}        ${profile.wants || dim('(not set)')}`);
  console.log(`${cyan('│')} ${bold('Flaw:')}         ${profile.flaw || dim('(not set)')}`);
  if (profile.backstory) console.log(`${cyan('│')} ${bold('Backstory:')}    ${profile.backstory}`);
  if (profile.secret)    console.log(`${cyan('│')} ${bold('Secret:')}       ${profile.secret}`);
  if (profile.relationships && Object.keys(profile.relationships).length) {
    const rels = Object.entries(profile.relationships).map(([k,v]) => `${k}: ${v}`).join('; ');
    console.log(`${cyan('│')} ${bold('Relationships:')} ${rels}`);
  }
  console.log(`${cyan('└───────────────────────────────────────────────────┘')}`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => {
    rl.question(`${yellow('>')} ${question} `, answer => resolve(answer.trim()));
  });
}

function askMultiline(prompt) {
  return new Promise(resolve => {
    console.log(`${yellow('>')} ${prompt}`);
    console.log(dim('  (Type your description. Press Enter on a blank line when done.)'));
    let lines = [];
    let blankCount = 0;

    const onLine = (line) => {
      if (line === '') {
        blankCount++;
        if (blankCount >= 1) {
          rl.removeListener('line', onLine);
          resolve(lines.join('\n').trim());
          return;
        }
      } else {
        blankCount = 0;
        lines.push(line);
      }
    };
    rl.on('line', onLine);
  });
}

// ─── Single character creation flow ──────────────────────────────────────────

async function createOneCharacter(index, total, existingNames = []) {
  console.log(`\n${bold(cyan(`── Character ${index + 1} of ${total} ──────────────────────────────`))}`);;
  console.log(dim('Describe this character in your own words. Be as specific or as vague as you like.'));
  console.log(dim('The more detail you give, the richer they\'ll be. Relationships with other characters are especially useful.'));
  if (existingNames.length) {
    console.log(dim(`Characters created so far: ${existingNames.join(', ')}`));
  }
  console.log('');

  const description = await askMultiline('Who is this person?');
  if (!description) {
    console.log(red('No description given. Skipping.'));
    return null;
  }

  console.log(`\n${dim('Parsing your description...')}`);

  let profile;
  try {
    profile = await parseDescription(description);
  } catch (err) {
    console.log(red(`\nFailed to parse description: ${err.message}`));
    console.log(dim('You can try again or skip this character.'));
    const retry = await ask('Try again? (y/n)');
    if (retry.toLowerCase() === 'y') return createOneCharacter(index, total, existingNames);
    return null;
  }

  // Clarification loop
  let attempts = 0;
  while (true) {
    const missing = getMissingFields(profile);
    if (missing.length === 0) break;
    if (attempts >= 3) {
      console.log(yellow('\nStill missing some details, but continuing with what we have.'));
      break;
    }

    console.log(`\n${yellow('A few things are still unclear. Let me ask some follow-up questions...')}\n`);

    let questions;
    try {
      questions = await generateClarifyingQuestions(profile, missing);
    } catch {
      questions = missing.map(f => `What is this character's ${f}?`);
    }

    const answers = [];
    for (const q of questions) {
      const a = await ask(q);
      if (a) answers.push(`Q: ${q}\nA: ${a}`);
    }

    if (answers.length) {
      const combined = `Original description: ${description}\n\nFollow-up Q&A:\n${answers.join('\n\n')}`;
      console.log(dim('\nUpdating profile...'));
      try {
        profile = await parseDescription(combined, profile);
      } catch (err) {
        console.log(red(`Parse error: ${err.message}. Keeping current profile.`));
      }
    }
    attempts++;
  }

  // Show profile and confirm
  printProfile(profile);
  console.log('');

  const confirm = await ask('Does this look right? (y to keep, n to redo, e to edit a field)');

  if (confirm.toLowerCase() === 'n') {
    console.log(dim('Let\'s try again.'));
    return createOneCharacter(index, total, existingNames);
  }

  if (confirm.toLowerCase() === 'e') {
    profile = await editProfile(profile);
  }

  return profile;
}

async function editProfile(profile) {
  const editableFields = ['name', 'role', 'traits', 'wants', 'flaw', 'backstory', 'secret'];
  console.log(`\n${bold('Which field do you want to edit?')}`);
  editableFields.forEach((f, i) => console.log(`  ${dim((i+1) + '.')} ${f}: ${
    Array.isArray(profile[f]) ? profile[f].join(', ') : (profile[f] || dim('(empty)'))
  }`));

  const choice = await ask('Enter field number (or press Enter to skip):');
  const idx    = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= editableFields.length) return profile;

  const field    = editableFields[idx];
  const newValue = await ask(`New value for ${bold(field)}:`);
  if (!newValue) return profile;

  if (field === 'traits') {
    profile.traits = newValue.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    profile[field] = newValue;
  }

  printProfile(profile);
  const again = await ask('Edit another field? (y/n)');
  if (again.toLowerCase() === 'y') return editProfile(profile);
  return profile;
}

// ─── Player character selection ───────────────────────────────────────────────

async function choosePlayerCharacter(profiles) {
  console.log(`\n${cyan('╔══════════════════════════════════════════════════╗')}`);
  console.log(`${cyan('║')}           ${bold('Would you like to play as one of them?')}      ${cyan('║')}`);
  console.log(`${cyan('╚══════════════════════════════════════════════════╝')}`);
  console.log(dim('\nIn player mode you\'ll walk around town and talk to people directly.'));
  console.log(dim('If you choose to just watch, all characters run as AI agents.\n'));

  profiles.forEach((p, i) => {
    console.log(`  ${cyan((i + 1) + '.')} ${bold(p.name)} — ${p.role}`);
  });
  console.log(`  ${cyan((profiles.length + 1) + '.')} ${dim('Just watch (observer mode)')}`);
  console.log('');

  const choice = await ask('Your choice:');
  const idx    = parseInt(choice) - 1;

  if (idx >= 0 && idx < profiles.length) {
    profiles[idx].isPlayer = true;
    console.log(green(`\nYou will play as ${bold(profiles[idx].name)}.`));
    console.log(dim(`The other ${profiles.length - 1} character(s) will be AI-driven.`));
  } else {
    console.log(green('\nObserver mode. All characters will be AI-driven.'));
    console.log(dim('You can open http://localhost:3000 to watch the dashboard.'));
  }

  return profiles;
}

// ─── Main flow ────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  // Check if characters already exist
  // In managed mode (launched via game.js) this menu is handled by the launcher.
  if (!process.env.MANAGED) {
    const existing = loadAllProfiles();
    if (existing.length > 0) {
      console.log(`${yellow('Characters already exist:')}`);
      existing.forEach((p, i) => printProfile(p, i));

      console.log('');
      const action = await ask(
        `What would you like to do?\n  ${cyan('1.')} Add more characters\n  ${cyan('2.')} Reset all characters and start over\n  ${cyan('3.')} Exit\n\n  Choice:`
      );

      if (action === '2') {
        const confirm = await ask(red('This will delete all existing characters. Are you sure? (yes/no)'));
        if (confirm.toLowerCase() !== 'yes') {
          console.log('Cancelled.'); rl.close(); return;
        }
        // Delete all character files
        const files = fs.readdirSync(CHARACTERS_DIR).filter(f => f.endsWith('.json') && f !== 'world_state.json');
        files.forEach(f => fs.unlinkSync(path.join(CHARACTERS_DIR, f)));
        console.log(green('All characters deleted.'));
        existing.length = 0;
      } else if (action === '3') {
        rl.close(); return;
      }
      // action === '1' falls through to creation below
    }
  }

  const currentCount = loadAllProfiles().length;

  // How many to create
  let numToCreate;
  if (currentCount === 0) {
    console.log(`${dim('How many characters would you like to create?')} ${dim('(2–8, recommended 3–5)')}`);
    const countAnswer = await ask('Number of characters:');
    numToCreate = Math.max(2, Math.min(8, parseInt(countAnswer) || 3));
    console.log(green(`Creating ${numToCreate} characters.\n`));
  } else {
    const addAnswer = await ask(`You have ${currentCount} character(s). How many more would you like to add?`);
    numToCreate = Math.max(1, Math.min(8 - currentCount, parseInt(addAnswer) || 1));
  }

  const allProfiles = loadAllProfiles();
  const existingNames = allProfiles.map(p => p.name);

  // Create each character
  for (let i = 0; i < numToCreate; i++) {
    const profile = await createOneCharacter(allProfiles.length, allProfiles.length + numToCreate, existingNames);
    if (profile) {
      const filepath = saveProfile(profile);
      allProfiles.push(profile);
      existingNames.push(profile.name);
      console.log(green(`\n✓ ${bold(profile.name)} saved.`));
    }
  }

  if (allProfiles.length === 0) {
    console.log(red('\nNo characters created. Exiting.'));
    rl.close(); return;
  }

  // Player character selection (only on first creation, not adding)
  const hasPlayerAlready = allProfiles.some(p => p.isPlayer);
  if (!hasPlayerAlready) {
    const finalProfiles = await choosePlayerCharacter(allProfiles);
    // Re-save any profile marked as player
    for (const p of finalProfiles) {
      if (p.isPlayer) saveProfile(p);
    }
  }

  // Summary
  console.log(`\n${cyan('╔══════════════════════════════════════════════════╗')}`);
  console.log(`${cyan('║')}                  ${bold('All set!')}                        ${cyan('║')}`);
  console.log(`${cyan('╚══════════════════════════════════════════════════╝')}`);
  console.log('');
  allProfiles.forEach((p, i) => {
    const tag = p.isPlayer ? green(' [YOU]') : dim(' [AI]');
    console.log(`  ${cyan((i+1) + '.')} ${bold(p.name)} — ${p.role}${tag}`);
  });

  if (!process.env.MANAGED) {
    const playerChar = allProfiles.find(p => p.isPlayer);
    console.log(`\n${bold('Next steps:')}`);
    console.log(`  ${cyan('1.')} Start the server:  ${bold('npm start')}`);
    console.log(`  ${cyan('2.')} Launch AI agents:  ${bold('npm run launch')}`);
    if (playerChar) {
      console.log(`  ${cyan('3.')} Play as ${playerChar.name}:     ${bold('npm run play')}`);
    } else {
      console.log(`  ${cyan('3.')} Open the dashboard: ${bold('http://localhost:3000')}`);
    }
    console.log('');
  }

  rl.close();
}

main().catch(err => {
  console.error(red('\nUnexpected error: ' + err.message));
  rl.close();
  process.exit(1);
});
