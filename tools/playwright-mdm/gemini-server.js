import { exec } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  attachToEdge,
  getAttachedBrowserContext,
  isCdpEndpointAvailable,
  launchEdgeWithProfile,
  waitForCdpEndpoint,
} from './attach.js';
import { extractLatestResponse, navigateToGemini, sendPrompt, sendPromptWithScreenshot, stopResponse, waitForResponseComplete } from './gemini.js';
import { closeAutomationBrowser, executeCommand } from './playwright-agent.js';

const PORT = 3000;
const CDP_ENDPOINT = 'http://127.0.0.1:9222';

const SYSTEM_PROMPT = `You are a browser automation assistant. When asked to do anything in a browser, respond with a JSON command block. Example:

\`\`\`json
{"action": "navigate", "url": "https://example.com"}
\`\`\`

Actions: navigate, screenshot, click (text or selector), type (selector + text), extract, scroll (direction), press (key), wait (ms). Chain multiple blocks for multi-step tasks. Reply "Ready." to confirm.`;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini Playwright Agent</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
    #header { background: #16213e; padding: 16px 24px; border-bottom: 1px solid #2a2a4a; display: flex; align-items: center; gap: 10px; }
    #header h1 { font-size: 18px; font-weight: 600; color: #8ab4f8; }
    #header .badge { font-size: 11px; background: #1a4a1a; color: #80e880; border-radius: 4px; padding: 2px 8px; font-weight: 500; }
    #messages { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
    .message { max-width: 82%; padding: 12px 16px; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-size: 15px; }
    .user     { align-self: flex-end; background: #1a73e8; color: white; border-radius: 12px 12px 4px 12px; }
    .gemini   { align-self: flex-start; background: #2a2a4a; color: #e0e0e0; border-radius: 12px 12px 12px 4px; }
    .thinking { align-self: flex-start; background: #2a2a4a; color: #888; border-radius: 12px; font-style: italic; }
    .error    { align-self: flex-start; background: #4a1a1a; color: #ff8a80; border-radius: 12px; }
    .action   { align-self: flex-start; background: #0d2b0d; color: #7be87b; border-radius: 8px; font-size: 13px; font-family: monospace; padding: 8px 14px; max-width: 90%; }
    .screenshot-wrap { align-self: flex-start; max-width: 90%; }
    .screenshot-wrap img { max-width: 100%; border-radius: 8px; display: block; border: 1px solid #3a3a6a; }
    .screenshot-wrap .caption { font-size: 12px; color: #888; margin-top: 4px; }
    #input-area { background: #16213e; padding: 16px 24px; border-top: 1px solid #2a2a4a; display: flex; gap: 12px; align-items: flex-end; }
    #input { flex: 1; background: #2a2a4a; border: 1px solid #3a3a6a; border-radius: 8px; padding: 12px 16px; color: #e0e0e0; font-size: 15px; resize: none; min-height: 48px; max-height: 200px; outline: none; font-family: inherit; line-height: 1.5; }
    #input:focus { border-color: #8ab4f8; }
    #send { background: #1a73e8; color: white; border: none; border-radius: 8px; padding: 12px 20px; cursor: pointer; font-size: 15px; font-weight: 500; height: 48px; white-space: nowrap; }
    #send:hover:not(:disabled) { background: #1557b0; }
    #send:disabled { background: #3a3a6a; cursor: not-allowed; color: #888; }
  </style>
</head>
<body>
  <div id="header">
    <h1>Gemini Playwright Agent</h1>
    <span class="badge">browser automation</span>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="input" placeholder="Ask Gemini to browse, click, screenshot, fill forms… (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
    <button id="send">Send</button>
  </div>
  <script>
    const messagesEl = document.getElementById('messages');
    const inputEl    = document.getElementById('input');
    const sendBtn    = document.getElementById('send');

    function addMessage(text, type) {
      const div = document.createElement('div');
      div.className = 'message ' + type;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function addScreenshot(b64, caption) {
      const wrap = document.createElement('div');
      wrap.className = 'screenshot-wrap';
      const img = document.createElement('img');
      img.src = 'data:image/png;base64,' + b64;
      wrap.appendChild(img);
      if (caption) {
        const cap = document.createElement('div');
        cap.className = 'caption';
        cap.textContent = caption;
        wrap.appendChild(cap);
      }
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function send() {
      const text = inputEl.value.trim();
      if (!text || sendBtn.disabled) return;

      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendBtn.disabled = true;
      inputEl.disabled = true;

      addMessage(text, 'user');
      const thinking = addMessage('Thinking…', 'thinking');

      try {
        const res = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
        });
        const data = await res.json();
        thinking.remove();

        if (data.error) {
          addMessage(data.error, 'error');
          return;
        }

        // Action status lines
        for (const line of (data.actionSummary ?? [])) {
          addMessage('▶ ' + line, 'action');
        }

        // Inline screenshots
        for (const { b64, url } of (data.screenshots ?? [])) {
          addScreenshot(b64, url ? 'Screenshot — ' + url : 'Screenshot');
        }

        if (data.response) addMessage(data.response, 'gemini');
      } catch {
        thinking.remove();
        addMessage('Connection error. Is the server still running?', 'error');
      } finally {
        sendBtn.disabled = false;
        inputEl.disabled = false;
        inputEl.focus();
      }
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    });
    inputEl.focus();
  </script>
</body>
</html>`;

// ---------- helpers ----------

function parsePlaywrightCommands(text) {
  const commands = [];
  const seen = new Set();

  function addCmd(parsed) {
    if (parsed && typeof parsed.action === 'string') {
      const key = JSON.stringify(parsed);
      if (!seen.has(key)) { seen.add(key); commands.push(parsed); }
    }
  }

  function tryBlock(content) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) parsed.forEach(addCmd);
      else addCmd(parsed);
    } catch {}
  }

  // 1. Fenced code blocks (```json, ```playwright, ``` bare, etc.)
  const fenceRe = /```[a-z]*\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) tryBlock(m[1].trim());

  // 2. Bare JSON (no code fence) — arrays and objects containing "action"
  if (commands.length === 0) {
    const arrRe = /(\[\s*\{[\s\S]*?"action"\s*:[\s\S]*?\}\s*\])/g;
    while ((m = arrRe.exec(text)) !== null) tryBlock(m[1].trim());

    const objRe = /(\{\s*"action"\s*:[\s\S]*?\})/g;
    while ((m = objRe.exec(text)) !== null) tryBlock(m[1].trim());
  }

  return commands;
}

function stripPlaywrightBlocks(text) {
  return text
    .replace(/```[a-z]*\s*[\[{][^`]*"action"[^`]*[\]}]\s*```/g, '')
    .replace(/\[\s*\{[^\]]*"action"[^\]]*\}\s*\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildAgentFeedback(stepResults) {
  const lines = stepResults.map(({ command, result }) => {
    if (result.type === 'error') return `❌ ${command.action} failed: ${result.error}`;
    if (result.type === 'navigate') return `✓ Navigated to: ${result.url} — "${result.title}"`;
    if (result.type === 'extract') return `✓ Extracted ${result.text?.length ?? 0} chars`;
    return `✓ ${result.message ?? result.type}`;
  });
  return (
    lines.join('\n') +
    '\n\nScreenshot of the current page is attached. What should I do next? If the task is complete, reply "Done." with no JSON block.'
  );
}

// ---------- request body ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- state ----------

let geminiPage = null;
let busy = false;

// ---------- agentic loop ----------

const MAX_STEPS = 8;

async function agentLoop(userMessage) {
  // Capture screenshot of the current browser state before every message to Gemini
  const initSs = await executeCommand({ action: 'screenshot' });
  if (initSs.type === 'screenshot') {
    const buf = Buffer.from(initSs.screenshot, 'base64');
    const attached = await sendPromptWithScreenshot(geminiPage, userMessage, buf);
    if (!attached) {
      // Image attach unavailable — fall back to text-only
      await sendPrompt(geminiPage, userMessage);
    }
  } else {
    await sendPrompt(geminiPage, userMessage);
  }
  await waitForResponseComplete(geminiPage);
  let rawResponse = await extractLatestResponse(geminiPage);

  const allActionSummary = [];
  // Include the initial screenshot so the UI shows what was sent to Gemini
  const allScreenshots = initSs.type === 'screenshot'
    ? [{ b64: initSs.screenshot, url: initSs.url ?? '' }]
    : [];

  for (let step = 0; step < MAX_STEPS; step++) {
    console.log(`\n--- Step ${step + 1}: Gemini (${rawResponse.length} chars) ---`);
    console.log(rawResponse.slice(0, 500));
    console.log('---\n');

    const commands = parsePlaywrightCommands(rawResponse);
    console.log(`Parsed ${commands.length} command(s):`, commands.map((c) => c.action));
    if (commands.length === 0) break;

    // Execute all commands in this step
    const stepResults = [];
    for (const cmd of commands) {
      console.log(`Executing: ${JSON.stringify(cmd)}`);
      const result = await executeCommand(cmd);
      console.log(`Result: ${JSON.stringify({ type: result.type, url: result.url, msg: result.message ?? result.error })}`);
      stepResults.push({ command: cmd, result });

      if (result.type === 'screenshot') {
        allScreenshots.push({ b64: result.screenshot, url: result.url });
      } else {
        const s =
          result.type === 'error' ? `ERROR (${cmd.action}): ${result.error}` :
          result.type === 'navigate' ? `Navigated → ${result.url}` :
          result.message ?? result.url ?? result.type;
        allActionSummary.push(s);
      }
    }

    // Auto-screenshot so Gemini can see what happened
    const ssResult = await executeCommand({ action: 'screenshot' });
    const feedbackText = buildAgentFeedback(stepResults);

    if (ssResult.type === 'screenshot') {
      const buf = Buffer.from(ssResult.screenshot, 'base64');
      const attached = await sendPromptWithScreenshot(geminiPage, feedbackText, buf);
      if (attached) {
        allScreenshots.push({ b64: ssResult.screenshot, url: ssResult.url });
        console.log('Screenshot attached to Gemini.');
      } else {
        // Image upload not supported — append page text as context
        const textResult = await executeCommand({ action: 'extract' });
        const pageCtx = textResult.type === 'extract'
          ? `\n\nCurrent page text (first 2000 chars):\n${textResult.text.slice(0, 2000)}`
          : '';
        await sendPrompt(geminiPage, feedbackText + pageCtx);
        console.log('Sent text-only feedback (screenshot attach unavailable).');
      }
    } else {
      await sendPrompt(geminiPage, feedbackText);
    }

    await waitForResponseComplete(geminiPage);
    rawResponse = await extractLatestResponse(geminiPage);
  }

  return {
    finalResponse: stripPlaywrightBlocks(rawResponse),
    screenshots: allScreenshots,
    actionSummary: allActionSummary,
  };
}

// ---------- chat handler ----------

async function handleChat(req, res) {
  if (busy) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Still working on the previous request. Please wait.' }));
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body.' }));
    return;
  }

  const message = body.message?.trim();
  if (!message) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Message cannot be empty.' }));
    return;
  }

  busy = true;
  try {
    const { finalResponse, screenshots, actionSummary } = await agentLoop(message);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ response: finalResponse, screenshots, actionSummary }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  } finally {
    busy = false;
  }
}

// ---------- HTTP server ----------

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.method === 'POST' && req.url === '/chat') {
    handleChat(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

// ---------- browser setup ----------

// Edge profile for Gemini automation (manfredsiew@hotmail.sg → Edge "Default")
const EDGE_PROFILE = 'Default';

function isEdgeRunning() {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq msedge.exe" /NH', (_err, stdout) => {
      resolve(typeof stdout === 'string' && stdout.toLowerCase().includes('msedge.exe'));
    });
  });
}

async function clearEdgeCrashFlag() {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const prefsPath = path.join(localAppData, 'Microsoft', 'Edge', 'User Data', EDGE_PROFILE, 'Preferences');

  try {
    const raw = await readFile(prefsPath, 'utf8');
    const prefs = JSON.parse(raw);

    const needsFix =
      prefs?.profile?.exit_type !== 'Normal' ||
      prefs?.profile?.exited_cleanly === false;

    if (needsFix) {
      if (!prefs.profile) prefs.profile = {};
      prefs.profile.exit_type = 'Normal';
      prefs.profile.exited_cleanly = true;
      await writeFile(prefsPath, JSON.stringify(prefs));
      console.log('Cleared Edge crash flag.');
    }
  } catch {
    // Preferences missing or unreadable — not fatal
  }
}

async function waitForEdgeClosed() {
  if (!(await isEdgeRunning())) return;

  console.log('\nEdge is already running.');
  console.log('Please close ALL Edge windows so this tool can launch it with remote debugging.');
  console.log('Waiting for Edge to close...\n');

  while (await isEdgeRunning()) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  await new Promise((r) => setTimeout(r, 2000));
  console.log('Edge closed. Continuing...');
}

async function setupBrowserAndGemini() {
  if (await isCdpEndpointAvailable()) {
    console.log(`Existing CDP endpoint at ${CDP_ENDPOINT}. Attaching without launching Edge.`);
    const { browser } = await attachToEdge();
    const context = getAttachedBrowserContext(browser);
    const page = await context.newPage();
    console.log('Navigating to Gemini...');
    await navigateToGemini(page);
    await primeGemini(page);
    return page;
  }

  await waitForEdgeClosed();
  await clearEdgeCrashFlag();

  console.log(`Launching Edge (profile: ${EDGE_PROFILE} — manfredsiew@hotmail.sg)...`);
  launchEdgeWithProfile(EDGE_PROFILE);

  // Allow up to 30 seconds for Edge to start and expose the CDP port
  if (!(await waitForCdpEndpoint({ attempts: 60, delayMs: 500 }))) {
    throw new Error(
      `Edge launched but ${CDP_ENDPOINT} did not become available after 30 s.\n` +
        `Ensure Edge is not already running, then try again.`,
    );
  }

  const { browser } = await attachToEdge();
  const context = getAttachedBrowserContext(browser);
  const page = await context.newPage();
  console.log('Navigating to Gemini...');
  await navigateToGemini(page);
  await primeGemini(page);
  return page;
}

async function primeGemini(page) {
  console.log('Sending system prompt to Gemini...');
  await sendPrompt(page, SYSTEM_PROMPT);
  try {
    await waitForResponseComplete(page, { timeout: 20000 });
  } catch {
    console.log('System prompt taking too long — stopping generation and continuing...');
    await stopResponse(page);
  }
  const ack = await extractLatestResponse(page).catch(() => '(pending)');
  console.log(`Gemini: ${ack.slice(0, 120)}${ack.length > 120 ? '…' : ''}`);
}

// ---------- entry point ----------

export async function run() {
  geminiPage = await setupBrowserAndGemini();

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nPlaywright agent ready — open http://localhost:${PORT}\n`);
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await closeAutomationBrowser();
    server.close();
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
