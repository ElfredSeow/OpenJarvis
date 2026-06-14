// jarvis-bridge.js
//
// Thin API that Open Jarvis core calls. The rest of Open Jarvis never touches
// Playwright directly — it asks for reasoning (askGemini) or research (research)
// and gets text/JSON back.
//
// "Powered-By-Webapp-LLM": instead of a paid Gemini API key, this drives the
// Gemini *web app* (gemini.google.com) inside your already signed-in,
// MDM-managed Edge profile. Your Gemini Webapp license is the reasoning brain.
//
// Design decision (per the integration plan): Gemini lives in a DEDICATED tab
// that is created once and reused. Research navigations happen on a SEPARATE
// page so they never clobber the Gemini conversation tab.

import { mkdir, writeFile } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

import {
  attachToEdge,
  getAttachedBrowserContext,
  isCdpEndpointAvailable,
  launchEdgeWithProfile,
  waitForCdpEndpoint,
} from './attach.js';
import {
  navigateToGemini,
  sendPrompt,
  waitForResponseComplete,
  extractLatestResponse,
} from './gemini.js';
import { executeCommand } from './playwright-agent.js';
import { loadConfig, requireConfiguredProfile } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = pathJoin(__dirname, 'reports', 'gemini-sessions');

// ---------------------------------------------------------------------------
// Singletons: attach once, keep ONE dedicated Gemini tab alive across calls.
// ---------------------------------------------------------------------------
let _browser = null;
let _context = null;
let _geminiPage = null;

async function getContext() {
  // Reuse a live connection if we already have one.
  if (_browser && _browser.isConnected() && _context) return _context;

  // If nothing is listening on the debug port yet, auto-launch the REMEMBERED
  // Edge profile (set once via `npm run setup`). No prompts, no re-picking.
  if (!(await isCdpEndpointAvailable())) {
    const cfg = await requireConfiguredProfile();
    console.log(`Launching remembered Edge profile: ${cfg.edgeProfile.label}`);
    launchEdgeWithProfile(cfg.edgeProfile.directory);
    if (!(await waitForCdpEndpoint())) {
      throw new Error(
        'Edge was launched but the debug port never opened. Fully close all Edge\n' +
          'windows and try again so Edge can relaunch with remote debugging.',
      );
    }
  }

  const { browser } = await attachToEdge();
  _browser = browser;
  _context = getAttachedBrowserContext(browser);
  return _context;
}

/**
 * Returns the single dedicated webapp-LLM tab, creating + navigating it on first
 * use. Never navigated away from the configured LLM URL, so the conversation is
 * preserved (no navigation clobbering).
 */
async function getGeminiPage() {
  const cfg = await loadConfig();
  const host = (() => {
    try { return new URL(cfg.llm?.url ?? 'https://gemini.google.com').host; }
    catch { return 'gemini.google.com'; }
  })();
  if (_geminiPage && !_geminiPage.isClosed()) {
    // Make sure we're still on the LLM host (a stray reload/redirect breaks selectors)
    if (_geminiPage.url().includes(host)) return _geminiPage;
  }
  const context = await getContext();
  _geminiPage = await context.newPage();
  await navigateToGemini(_geminiPage, { url: cfg.llm?.url });
  return _geminiPage;
}

async function logSession(kind, prompt, response) {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = pathJoin(SESSIONS_DIR, `${stamp}_${kind}.json`);
    await writeFile(
      file,
      JSON.stringify({ kind, at: new Date().toISOString(), prompt, response }, null, 2),
      'utf8',
    );
  } catch {
    // auditing is best-effort; never block the caller
  }
}

// ---------------------------------------------------------------------------
// REASON: use the Gemini Webapp license to PRODUCE content.
// Jarvis stores whatever text comes back (summaries, ideas, scripts, copy...).
// ---------------------------------------------------------------------------
export async function askGemini(prompt, { timeout = 120000 } = {}) {
  const page = await getGeminiPage();
  await sendPrompt(page, prompt);
  await waitForResponseComplete(page, { timeout });
  const response = await extractLatestResponse(page);
  await logSession('reason', prompt, response);
  return response;
}

// ---------------------------------------------------------------------------
// ACT / RESEARCH: open a SEPARATE page to look at a live URL, hand what we see
// to Gemini (on its dedicated tab), and return Gemini's analysis. The Gemini
// conversation tab is never navigated, so no clobbering.
// ---------------------------------------------------------------------------
export async function research(url, objective, { maxChars = 6000, timeout = 120000 } = {}) {
  const context = await getContext();
  const researchPage = await context.newPage();
  let observed = '';
  try {
    await researchPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await researchPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    observed = (await researchPage.locator('body').innerText().catch(() => '')).slice(0, maxChars);
  } finally {
    await researchPage.close().catch(() => {});
  }

  const prompt =
    `You are Open Jarvis's research analyst.\n` +
    `Source URL: ${url}\n` +
    `Objective: ${objective}\n\n` +
    `Below is the visible text extracted from that page. Analyse it toward the objective ` +
    `and reply with concise findings (themes, post types, inferred goals, opportunities).\n\n` +
    `--- PAGE TEXT START ---\n${observed}\n--- PAGE TEXT END ---`;

  const findings = await askGemini(prompt, { timeout });
  await logSession('research', `${objective} @ ${url}`, findings);
  return findings;
}

// ---------------------------------------------------------------------------
// ACT (autonomous): ask Gemini to PLAN browser commands, then run them with the
// Playwright agent. Gemini replies with ```json {...}``` command blocks.
// ---------------------------------------------------------------------------
export async function act(objective, { timeout = 120000 } = {}) {
  const prompt =
    `You are a browser automation planner for Open Jarvis. Goal: ${objective}.\n` +
    `Reply ONLY with one or more JSON command blocks in \`\`\`json fences.\n` +
    `Actions: navigate(url), click(text|selector), type(selector,text), extract(selector), ` +
    `screenshot, scroll(direction), press(key), wait(ms).`;
  const reply = await askGemini(prompt, { timeout });

  const results = [];
  for (const command of parseCommands(reply)) {
    if (command.__error) { results.push({ type: 'error', error: command.__error, raw: command.raw }); continue; }
    results.push(await executeCommand(command));
  }
  return { plan: reply, results };
}

// Extract the browser commands from Gemini's reply. Prefer explicit ```json
// fences, but fall back to bare JSON — when the answer is read from Gemini's
// *rendered* DOM the ``` fences are gone, leaving a plain JSON array/object.
function parseCommands(reply) {
  const out = [];
  const blockRe = /```json\s*([\s\S]*?)```/g;
  let m, sawFence = false;
  while ((m = blockRe.exec(reply)) !== null) {
    sawFence = true;
    try { pushCommands(JSON.parse(m[1].trim()), out); }
    catch { out.push({ __error: 'unparseable command block', raw: m[1].trim() }); }
  }
  if (out.length || sawFence) return out;
  const bare = sliceBalancedJson(reply);
  if (bare) { try { pushCommands(JSON.parse(bare), out); } catch { /* not JSON */ } }
  return out;
}

// Accept an array of commands, a single command object, or { commands: [...] }.
function pushCommands(parsed, out) {
  if (Array.isArray(parsed)) parsed.forEach((c) => c && out.push(c));
  else if (parsed && Array.isArray(parsed.commands)) parsed.commands.forEach((c) => c && out.push(c));
  else if (parsed && parsed.action) out.push(parsed);
}

// Return the first balanced JSON array/object substring, ignoring brackets
// that appear inside strings. Null if none.
function sliceBalancedJson(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// Release handles (Jarvis can call on shutdown). Leaves Edge itself running.
export async function dispose() {
  try {
    if (_geminiPage && !_geminiPage.isClosed()) await _geminiPage.close();
  } catch {
    /* ignore */
  }
  _geminiPage = null;
  _context = null;
  _browser = null;
}

// Tiny smoke runner: `node jarvis-bridge.js "your prompt"`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prompt = process.argv.slice(2).join(' ') || 'In one sentence, confirm you are reachable.';
  askGemini(prompt)
    .then((r) => {
      console.log('\nGemini:', r, '\n');
      return dispose();
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
