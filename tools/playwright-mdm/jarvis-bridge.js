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
  acquireEdgeBrowser,
  getAttachedBrowserContext,
  isCdpEndpointAvailable,
} from './attach.js';
import {
  navigateToGemini,
  sendPrompt,
  sendPromptWithScreenshot,
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
let _endpoint = null;

/** Public: the attached, signed-in Edge context (auto-launches the remembered
 * profile if needed). Other modules (e.g. the LinkedIn poster) reuse this so
 * they ride your existing logged-in session instead of a fresh browser. */
export async function getEdgeContext() {
  return getContext();
}

async function getContext() {
  // Reuse a live connection if we already have one.
  if (_browser && _browser.isConnected() && _context) return _context;

  const cfg = await loadConfig();
  const preferredPort = cfg.cdpPort || 9222;
  const profileDirectory = cfg.edgeProfile?.directory;

  // Nothing to reuse and no remembered profile → friendly setup error.
  if (!profileDirectory && !(await isCdpEndpointAvailable(preferredPort))) {
    await requireConfiguredProfile();
  }

  // Reuse the existing CDP if free; otherwise launch the remembered profile;
  // and if the preferred port is busy (Edge already running), open ANOTHER CDP
  // on its own — a dedicated instance on a free port. No need to close Edge.
  const { browser, endpoint, mode, port } = await acquireEdgeBrowser({
    profileDirectory, preferredPort, onLog: (m) => console.log(m),
  });
  console.log(`CDP ${mode} on port ${port} (${endpoint}).`);

  _browser = browser;
  _endpoint = endpoint;
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
// VISION: hand Gemini a SCREENSHOT plus a prompt and get its reading back. Used
// by the self-healing resolver so the engine can "see" the page and correct
// itself when static selectors miss.
// ---------------------------------------------------------------------------
export async function askGeminiVision(prompt, screenshotBuffer, { timeout = 120000 } = {}) {
  const page = await getGeminiPage();
  await sendPromptWithScreenshot(page, prompt, screenshotBuffer);
  await waitForResponseComplete(page, { timeout });
  const response = await extractLatestResponse(page);
  await logSession('vision', prompt, response);
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
function agentPrompt(objective) {
  return (
    `You are a browser automation planner for Open Jarvis. Goal: ${objective}.\n` +
    `Reply ONLY with one or more JSON command blocks in \`\`\`json fences.\n` +
    `Actions: navigate(url), click(text|selector), type(selector,text), extract(selector), ` +
    `screenshot, scroll(direction), press(key), wait(ms).`
  );
}

export async function act(objective, { timeout = 120000 } = {}) {
  const reply = await askGemini(agentPrompt(objective), { timeout });

  const results = [];
  for (const command of parseCommands(reply)) {
    if (command.__error) { results.push({ type: 'error', error: command.__error, raw: command.raw }); continue; }
    results.push(await executeCommand(command));
  }
  return { plan: reply, results };
}

// Streaming variant: emits onStep({label, image?, ...}) so the Hub can show a
// live screen of what the agent is doing — a frame after each executed command.
export async function actStream(objective, { onStep = () => {}, timeout = 120000 } = {}) {
  onStep({ label: 'Planning with Gemini…' });
  const reply = await askGemini(agentPrompt(objective), { timeout });
  onStep({ label: 'Plan ready' });

  const { executeCommand, agentScreenshot } = await import('./playwright-agent.js');
  const commands = parseCommands(reply);
  const results = [];
  const shot = async (label, extra = {}) => {
    let image = null;
    try { image = (await agentScreenshot()).toString('base64'); } catch { /* page may not exist yet */ }
    onStep({ label, image, ...extra });
  };
  for (const [i, command] of commands.entries()) {
    if (command.__error) { results.push({ type: 'error', error: command.__error, raw: command.raw }); onStep({ label: `Step ${i + 1}: ${command.__error}` }); continue; }
    onStep({ label: `Step ${i + 1}: ${command.action}${command.url ? ' → ' + command.url : ''}` });
    const r = await executeCommand(command);
    results.push(r);
    await shot(`Step ${i + 1} done`, { result: r });
  }
  if (!commands.length) onStep({ label: 'No runnable commands were planned.' });
  return { plan: reply, results };
}

// ---------------------------------------------------------------------------
// VISION ACT: continuous screenshot → Gemini → single-action loop.
//
// Unlike act/actStream (which plan all steps upfront then execute blind),
// actVision sends a SCREENSHOT to Gemini before EVERY decision. Gemini sees
// the live browser state and replies with ONE JSON action. After each action
// another screenshot is captured and fed into the next Gemini call. Errors
// are included as context so Gemini can self-recover instead of getting stuck.
// ---------------------------------------------------------------------------

function visionStepPrompt(objective, history, lastError) {
  const lines = [
    'You are a browser automation agent controlling a real web browser.',
    `Objective: ${objective}`,
  ];
  if (history.length) {
    lines.push('\nActions completed so far:');
    history.forEach((h, i) => lines.push(`  ${i + 1}. ${h}`));
  }
  if (lastError) {
    lines.push(`\nThe LAST action FAILED with this error: "${lastError}"`);
    lines.push('Look carefully at the screenshot and try a DIFFERENT approach.');
  }
  lines.push(
    '\nThe attached screenshot shows the CURRENT browser state.',
    'What is the SINGLE NEXT ACTION to take toward completing the objective?',
    '',
    'Reply with exactly ONE JSON object — no markdown fences, no extra text:',
    '  Navigate to URL:  {"action":"navigate","url":"https://..."}',
    '  Click by text:    {"action":"click","text":"visible text of element"}',
    '  Click by CSS:     {"action":"click","selector":"css-selector"}',
    '  Type into field:  {"action":"type","selector":"css-selector","text":"value"}',
    '  Scroll page:      {"action":"scroll","direction":"down"}  (or "up")',
    '  Press a key:      {"action":"press","key":"Enter"}',
    '  Wait:             {"action":"wait","ms":1500}',
    '  Extract text:     {"action":"extract","selector":"body"}',
    '  Task complete:    {"action":"done","summary":"what was accomplished"}',
    '',
    'RULES:',
    '  - Use "done" when the objective is FULLY achieved or nothing more can be done.',
    '  - Never repeat a failed action with the exact same parameters.',
    '  - If an element is not visible, try scrolling down or waiting.',
    '  - Prefer clicking by visible text over CSS selectors.',
    '  - Reply with ONLY the JSON object — no explanations, no fences.',
  );
  return lines.join('\n');
}

// Parse a single JSON command object from Gemini's reply.
// Strips markdown fences and finds the first balanced {} if plain JSON.parse fails.
function parseOneCommand(reply) {
  const cleaned = reply.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const start = cleaned.search(/\{/);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch {} }
  }
  return null;
}

/**
 * Continuous vision-grounded browser agent.
 *
 * Every Gemini call receives the current screenshot so it always "sees" the
 * browser before deciding what to do next. On error the failure reason is
 * included in the next prompt so Gemini can adapt instead of repeating the
 * same broken action.
 *
 * @param {string} objective - Natural-language task description.
 * @param {object} opts
 * @param {Function} opts.onStep  - Callback({ label, image? }) for live UI updates.
 * @param {number}  opts.maxSteps - Hard cap on loop iterations (default 40).
 * @param {number}  opts.timeout  - Per-Gemini-call timeout ms (default 120000).
 * @returns {{ ok, summary, steps }} Result object.
 */
export async function actVision(objective, { onStep = () => {}, maxSteps = 40, timeout = 120000 } = {}) {
  const { executeCommand, agentScreenshot } = await import('./playwright-agent.js');
  const history = [];
  let lastError = null;
  let consecutiveErrors = 0;

  for (let step = 0; step < maxSteps; step++) {
    // 1. Capture current browser state (screenshot feeds into the Gemini prompt)
    let screenshot = null;
    try { screenshot = await agentScreenshot({ type: 'jpeg', quality: 70 }); } catch { /* page not open yet */ }
    const imageB64 = screenshot ? screenshot.toString('base64') : null;

    // 2. Tell the UI what we see and that we're asking Gemini
    onStep({ label: `Step ${step + 1}: analysing screen, asking Gemini what to do next…`, image: imageB64 });

    // 3. Ask Gemini — always include the screenshot when available
    const prompt = visionStepPrompt(objective, history, lastError);
    let reply = '';
    try {
      reply = screenshot
        ? await askGeminiVision(prompt, screenshot, { timeout })
        : await askGemini(prompt, { timeout });
    } catch (e) {
      onStep({ label: `Gemini error: ${e.message}` });
      return { ok: false, summary: `Gemini unreachable: ${e.message}`, steps: history };
    }

    // 4. Parse Gemini's reply as a single command
    const command = parseOneCommand(reply);
    if (!command?.action) {
      consecutiveErrors++;
      lastError = `Gemini replied with unparseable text: "${reply.slice(0, 100)}"`;
      onStep({ label: `⚠ Could not parse Gemini reply — retrying (${consecutiveErrors}/3)…` });
      if (consecutiveErrors >= 3) return { ok: false, summary: 'Repeated parse failures from Gemini', steps: history };
      continue;
    }

    // 5. Objective achieved?
    if (command.action === 'done') {
      onStep({ label: `✅ Done: ${command.summary || 'task complete'}`, image: imageB64 });
      return { ok: true, summary: command.summary || 'done', steps: history };
    }

    // 6. Log and emit what we're about to do
    const actionLabel = command.url
      ? `${command.action} → ${command.url}`
      : command.text ? `${command.action} "${command.text}"`
      : command.key  ? `${command.action} [${command.key}]`
      : command.selector ? `${command.action} on ${command.selector}`
      : command.action;
    onStep({ label: `Step ${step + 1}: ${actionLabel}` });

    // 7. Execute the action
    const result = await executeCommand(command);

    if (result.type === 'error') {
      consecutiveErrors++;
      lastError = result.error;
      history.push(`[FAILED] ${actionLabel} — ${result.error}`);
      onStep({ label: `⚠ Failed: ${result.error}` });
      // After 5 consecutive failures give up — something is fundamentally wrong
      if (consecutiveErrors >= 5) {
        onStep({ label: '5 consecutive failures — stopping to avoid an infinite loop.' });
        return { ok: false, summary: `Stuck after 5 consecutive failures: ${result.error}`, steps: history };
      }
      // Continue: the next iteration will show Gemini the current screenshot + lastError
    } else {
      consecutiveErrors = 0;
      lastError = null;
      history.push(actionLabel);
      onStep({ label: `✓ ${actionLabel}` });

      // Capture a fresh screenshot after each successful action and stream it
      try {
        const postShot = await agentScreenshot({ type: 'jpeg', quality: 70 });
        onStep({ label: null, image: postShot.toString('base64') });
      } catch { /* ignore if page closed */ }
    }
  }

  return { ok: false, summary: `Max steps (${maxSteps}) reached without completing the objective`, steps: history };
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
  _endpoint = null;
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
