// config.js
//
// "Set once, auto-remember." Stores the Edge profile you chose and the webapp
// LLM that powers Open Jarvis, so you never have to pick again. The bridge reads
// this file and auto-launches the right profile on demand.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CONFIG_PATH = pathJoin(__dirname, 'jarvis-mdm.config.json');

// Known webapp LLMs you can power Open Jarvis with. Add more here to expand.
export const LLM_PRESETS = {
  gemini: {
    name: 'Gemini',
    url: 'https://gemini.google.com',
  },
  aistudio: {
    name: 'Google AI Studio',
    url: 'https://aistudio.google.com',
  },
  chatgpt: {
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
  },
};

const DEFAULTS = {
  edgeProfile: null, // { directory, label }
  llm: LLM_PRESETS.gemini, // { name, url }
  cdpPort: 9222,
};

export function configExists() {
  return existsSync(CONFIG_PATH);
}

export async function loadConfig() {
  if (!configExists()) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(partial) {
  const current = await loadConfig();
  const next = { ...current, ...partial, savedAt: new Date().toISOString() };
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Throws a friendly error if setup hasn't been run yet. */
export async function requireConfiguredProfile() {
  const cfg = await loadConfig();
  if (!cfg.edgeProfile?.directory) {
    throw new Error(
      'No Edge profile remembered yet. Run "npm run setup" once to pick the\n' +
        'profile and the webapp LLM that powers Open Jarvis.',
    );
  }
  return cfg;
}
