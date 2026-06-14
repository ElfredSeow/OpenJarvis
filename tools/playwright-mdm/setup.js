// setup.js
//
// One-time picker. Lists your installed Edge profiles, lets you choose the one
// that is signed into your webapp LLM (e.g. your Gemini license), lets you pick
// which webapp powers Open Jarvis, and SAVES the choice. After this, the bridge
// auto-remembers — you never pick again.
//
//   npm run setup

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  discoverEdgeProfiles,
  formatProfileLabel,
  getDefaultLocalStatePath,
} from './attach.js';
import { LLM_PRESETS, saveConfig, loadConfig, CONFIG_PATH } from './config.js';

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const existing = await loadConfig();
    if (existing.edgeProfile?.directory) {
      console.log(`\nCurrent setup → profile "${existing.edgeProfile.label}" powered by ${existing.llm.name}.`);
      const change = (await rl.question('Reconfigure? (y/N): ')).trim().toLowerCase();
      if (change !== 'y' && change !== 'yes') {
        console.log('Keeping existing setup. Nothing changed.');
        return;
      }
    }

    // 1) Pick the Edge profile (the "click the Edge browser you want to run on")
    const profiles = await discoverEdgeProfiles(getDefaultLocalStatePath());
    if (profiles.length === 0) {
      throw new Error('No Edge profiles found. Open Edge at least once, then retry.');
    }
    console.log('\nWhich Edge profile should Open Jarvis drive?');
    console.log('(Pick the one already signed into the webapp LLM you want to use.)\n');
    profiles.forEach((p, i) => console.log(`  ${i + 1}. ${formatProfileLabel(p)}`));

    let profile = null;
    while (!profile) {
      const ans = (await rl.question('\nProfile number: ')).trim();
      const idx = Number.parseInt(ans, 10) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < profiles.length) {
        profile = profiles[idx];
      } else {
        console.log('Please enter a valid number from the list.');
      }
    }

    // 2) Pick the powering webapp LLM ("the web browser I want to power Open Jarvis")
    const presets = Object.entries(LLM_PRESETS);
    console.log('\nWhich webapp should power Open Jarvis?\n');
    presets.forEach(([key, v], i) => console.log(`  ${i + 1}. ${v.name}  (${v.url})`));
    console.log(`  ${presets.length + 1}. Custom URL`);

    let llm = null;
    while (!llm) {
      const ans = (await rl.question('\nLLM number (Enter = 1 Gemini): ')).trim();
      if (ans === '') { llm = LLM_PRESETS.gemini; break; }
      const idx = Number.parseInt(ans, 10) - 1;
      if (idx === presets.length) {
        const url = (await rl.question('Custom webapp URL: ')).trim();
        const name = (await rl.question('Friendly name: ')).trim() || 'Custom';
        if (url) llm = { name, url };
      } else if (Number.isInteger(idx) && idx >= 0 && idx < presets.length) {
        llm = presets[idx][1];
      }
      if (!llm) console.log('Please enter a valid number.');
    }

    const saved = await saveConfig({
      edgeProfile: { directory: profile.directory, label: formatProfileLabel(profile) },
      llm,
    });

    console.log('\n✓ Saved. Open Jarvis will remember this from now on.');
    console.log(`  Profile : ${saved.edgeProfile.label}`);
    console.log(`  Powered : ${saved.llm.name} (${saved.llm.url})`);
    console.log(`  Stored  : ${CONFIG_PATH}`);
    console.log('\nNext: close Edge, then just call the bridge — it auto-launches this profile.');
    console.log('  npm run bridge -- "In one sentence, confirm you are reachable."');
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error('\nSetup failed:', e.message);
  process.exitCode = 1;
});
