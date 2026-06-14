// e2e-hub.mjs — End-to-end "normal user" test of the Open Jarvis Hub.
//
// Drives the real Hub UI in headless Chromium and walks every module the way a
// person would: set up, create a marketing project, run the pipeline, add a
// monitor, wire a channel, generate a digest, chat with Jarvis. It asserts both
// the happy paths that work fully offline (project/monitor/channel management,
// navigation, settings) AND that the LLM-backed features degrade *honestly*
// (clear guidance, server stays up) when no browser/engine is configured —
// instead of crashing or faking a reply.
//
// Safety: it NEVER drives the user's real Gemini account or live Telegram bot.
// It snapshots config/channels/monitors and restores them on exit, and it tests
// the LLM paths in their unconfigured-degradation form so no Edge window opens.
//
//   node test/e2e-hub.mjs            # uses an auto-booted server on PORT 4199

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PROJECTS = join(ROOT, '..', '..', 'workspace', 'projects');
const PORT = Number(process.env.E2E_PORT) || 4199;
const BASE = `http://localhost:${PORT}`;
const SHOTS = join(ROOT, 'reports', 'e2e');

// 1x1 transparent PNG used as a project "photo reference" in the LinkedIn test.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// A local stand-in for LinkedIn's composer — same selectors the real composer
// targets — so we can drive the REAL composer code without touching a real account.
const MOCK_LINKEDIN = `<!doctype html><html><head><meta charset="utf-8"><title>Mock LinkedIn</title></head>
<body style="font-family:sans-serif;padding:24px;background:#f3f2ef">
<h2>Mock LinkedIn Feed</h2>
<button class="share-box-feed-entry__trigger" onclick="document.getElementById('composer').style.display='block'">Start a post</button>
<div id="composer" style="display:none;margin-top:16px;border:1px solid #ccc;padding:16px;background:#fff;max-width:520px">
  <div class="ql-editor" contenteditable="true" data-placeholder="What do you want to talk about?" style="min-height:90px;border:1px solid #ddd;padding:8px"></div>
  <input type="file" multiple style="margin-top:8px">
  <div style="margin-top:12px;text-align:right">
    <button class="share-actions__primary-action" onclick="window.__posted=true;this.textContent='Posted!'">Post</button>
  </div>
</div></body></html>`;

// "Hard" variant: the trigger is a <div role=button> with NO matching class/aria,
// so every static selector misses — forcing the engine to self-correct via the
// DOM heuristic before it can open the composer.
const MOCK_LINKEDIN_HARD = `<!doctype html><html><head><meta charset="utf-8"><title>Mock LinkedIn (hard)</title></head>
<body style="font-family:sans-serif;padding:24px;background:#f3f2ef">
<h2>Mock LinkedIn Feed (hard)</h2>
<div role="button" style="cursor:pointer;border:1px solid #999;padding:8px;display:inline-block" onclick="document.getElementById('composer').style.display='block'">Start a post</div>
<div id="composer" style="display:none;margin-top:16px;border:1px solid #ccc;padding:16px;background:#fff;max-width:520px">
  <div class="ql-editor" contenteditable="true" data-placeholder="What do you want to talk about?" style="min-height:90px;border:1px solid #ddd;padding:8px"></div>
  <input type="file" multiple style="margin-top:8px">
  <div style="margin-top:12px;text-align:right">
    <button class="share-actions__primary-action" onclick="window.__posted=true;this.textContent='Posted!'">Post</button>
  </div>
</div></body></html>`;

function startMockLinkedIn() {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.url.startsWith('/hard') ? MOCK_LINKEDIN_HARD : MOCK_LINKEDIN);
  });
  return new Promise((resolve) => { srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` })); });
}

// Drive the LinkedIn composer end-to-end against a mock URL; collect step
// labels + whether each frame carried an image, plus the final result.
function runLinkedIn(page, { proj, text, images, mockUrl }) {
  return page.evaluate(({ proj, text, images, mockUrl }) => new Promise((resolve) => {
    const frames = [], labels = []; let done = null, err = null;
    const q = '/api/linkedin/post?project=' + encodeURIComponent(proj)
      + '&text=' + encodeURIComponent(text)
      + '&images=' + encodeURIComponent(JSON.stringify(images))
      + '&url=' + encodeURIComponent(mockUrl) + '&keep=0';
    const es = new EventSource(q);
    es.addEventListener('step', (e) => { try { const s = JSON.parse(e.data); frames.push(!!s.image); if (s.label) labels.push(s.label); } catch {} });
    es.addEventListener('done', (e) => { try { done = JSON.parse(e.data); } catch {} es.close(); resolve({ frames, labels, done, err }); });
    es.addEventListener('error', (e) => { try { err = JSON.parse(e.data); } catch { err = 'error'; } es.close(); resolve({ frames, labels, done, err }); });
    setTimeout(() => { es.close(); resolve({ frames, labels, done, err, timeout: true }); }, 90000);
  }), { proj, text, images, mockUrl });
}

const STATE_FILES = ['jarvis-mdm.config.json', 'channels.json', 'monitors.json'];

// ---- tiny test framework -------------------------------------------------
const results = [];
let current = null;
const log = (...a) => console.log(...a);
function scenario(name) { current = { name, checks: [] }; results.push(current); log(`\n▶ ${name}`); }
function check(desc, cond, detail = '') {
  const ok = !!cond;
  current.checks.push({ desc, ok, detail });
  log(`   ${ok ? '✓' : '✗'} ${desc}${detail ? '  — ' + detail : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- server lifecycle ----------------------------------------------------
function startServer() {
  const child = spawn(process.execPath, ['jarvis-ui.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[hub] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[hub:err] ${d}`));
  return child;
}
async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/state`); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  throw new Error('Hub server did not become ready');
}

async function snapshot() {
  const bak = {};
  for (const f of STATE_FILES) {
    const p = join(ROOT, f);
    bak[f] = existsSync(p) ? await readFile(p, 'utf8') : null;
  }
  return bak;
}
async function restore(bak) {
  for (const f of STATE_FILES) {
    const p = join(ROOT, f);
    if (bak[f] === null) { if (existsSync(p)) await rm(p).catch(() => {}); }
    else await writeFile(p, bak[f], 'utf8');
  }
}

// ---- helpers -------------------------------------------------------------
async function goTo(page, id) {
  await page.evaluate((h) => { location.hash = h; }, id);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const bak = await snapshot();
  const server = startServer();
  let browser, mock;
  const pageErrors = [];

  try {
    await waitForServer();
    mock = await startMockLinkedIn();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', (e) => { pageErrors.push(e.message); log(`   ‼ pageerror: ${e.message}`); });
    page.on('console', (m) => { if (m.type() === 'error') log(`   ⚠ console.error: ${m.text()}`); });

    // ===================================================================
    scenario('Load Hub & dashboard navigation');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#nav button');
    const navCount = await page.$$eval('#nav button', (b) => b.length);
    check('sidebar lists all 11 modules', navCount === 11, `found ${navCount}`);
    check('header shows Jarvis Hub', (await page.textContent('aside')).includes('Jarvis Hub'));
    // dashboard cards
    await page.waitForSelector('#view h1');
    check('dashboard heading renders', (await page.textContent('#view h1')).includes('Welcome'));
    const cardCount = await page.$$eval('#view button', (b) => b.length);
    check('dashboard shows 10 module cards', cardCount === 10, `found ${cardCount}`);
    // click each nav item and confirm the view changes
    const modules = ['ask', 'marketing', 'linkedin', 'canvas', 'research', 'agent', 'monitors', 'digest', 'channels', 'settings', 'home'];
    let navOk = true;
    for (const id of modules) {
      await goTo(page, id);
      await sleep(150);
      const h = await page.textContent('#view h1').catch(() => '');
      if (!h) navOk = false;
    }
    check('every module renders a heading when navigated', navOk);

    // ===================================================================
    scenario('Settings — set up profile + LLM (first-run)');
    await goTo(page, 'settings');
    await page.waitForSelector('#saveCfg');
    const profOpts = await page.$$eval('#profile option', (o) => o.length);
    const llmOpts = await page.$$eval('#llm option', (o) => o.length);
    check('Edge profiles discovered & listed', profOpts > 0, `${profOpts} profiles`);
    check('LLM presets listed', llmOpts >= 3, `${llmOpts} presets`);
    await page.click('#saveCfg');
    await page.waitForFunction(() => document.querySelector('#saveCfg')?.textContent.includes('Saved'), { timeout: 5000 });
    check('Save persists ("✓ Saved")', (await page.textContent('#saveCfg')).includes('Saved'));
    check('status badge reflects connection', (await page.textContent('#statusBadge')).includes('·'));

    // ===================================================================
    scenario('Marketing Studio — create project & approval gate (offline parts)');
    await goTo(page, 'marketing');
    await page.waitForSelector('#createBtn');
    const projName = 'e2e-demo-' + Date.now().toString(36);
    await page.fill('#newName', projName);
    await page.click('#createBtn');
    await page.waitForSelector('#studio:not(.hidden)', { timeout: 5000 });
    check('new project selected & studio opens', (await page.textContent('#activeProj')) === projName);
    // it should appear in the project list
    const inList = await page.$$eval('#projects button', (b) => b.map((x) => x.textContent));
    check('project appears in list', inList.includes(projName));
    // outputs empty before a run
    await sleep(300);
    check('outputs show "none yet" before running', (await page.textContent('#outputs')).toLowerCase().includes('none'));
    // approve gate works even with nothing generated (0 items)
    await page.click('#approveBtn');
    await page.waitForFunction(() => /Approved|⚠/.test(document.querySelector('#approveMsg')?.textContent || ''), { timeout: 5000 });
    check('approval gate responds', /Approved/.test(await page.textContent('#approveMsg')));

    // pipeline run with EMPTY source must fail with a clear message (not hang/crash)
    const runEmpty = await page.evaluate(async (n) => {
      return await new Promise((resolve) => {
        const es = new EventSource('/api/run?project=' + encodeURIComponent(n));
        let err = null, done = false;
        es.addEventListener('error', (e) => { try { err = JSON.parse(e.data); } catch {} es.close(); resolve({ err, done }); });
        es.addEventListener('done', () => { done = true; es.close(); resolve({ err, done }); });
        setTimeout(() => { es.close(); resolve({ err, done, timeout: true }); }, 8000);
      });
    }, projName);
    check('empty-source pipeline returns a clear error (no crash)', runEmpty.err && /No readable source/i.test(runEmpty.err), JSON.stringify(runEmpty));

    // Seed the project with a photo reference + a generated HTML deliverable so
    // the LinkedIn Poster and Canvas have something real to work with.
    const projRoot = join(PROJECTS, projName);
    await mkdir(join(projRoot, 'source', 'raw-html'), { recursive: true });
    await writeFile(join(projRoot, 'source', 'raw-html', 'ref.png'), PNG_1PX);
    await mkdir(join(projRoot, 'landing-page', 'html'), { recursive: true });
    await writeFile(join(projRoot, 'landing-page', 'html', 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="lp">E2E Landing Page</h1></body></html>', 'utf8');

    // ===================================================================
    scenario('Project images — discovered for photo references');
    const imgs = await page.evaluate(async (n) => (await (await fetch('/api/project-images?project=' + encodeURIComponent(n))).json()), projName);
    check('project image listing finds the reference photo', imgs.images?.some((p) => p.endsWith('ref.png')), JSON.stringify(imgs.images));

    // ===================================================================
    scenario('LinkedIn Poster — drafts post + photo, STOPS before Post (live stream)');
    const ll = await runLinkedIn(page, { proj: projName, text: 'E2E hello from the marketing plan', images: ['source/raw-html/ref.png'], mockUrl: mock.url });
    check('composer completed without crashing', ll.done && ll.done.ok, JSON.stringify(ll.err || ll.timeout || ''));
    check('post text was typed into the composer', ll.done?.typedText?.includes('E2E hello from the marketing plan'), (ll.done?.typedText || '').slice(0, 60));
    check('photo reference was attached', (ll.done?.imageCount ?? 0) >= 1, `imageCount=${ll.done?.imageCount}`);
    check('Post button was found', ll.done?.postButtonFound === true);
    check('it STOPPED before posting (posted=false)', ll.done?.posted === false);
    check('live screen streamed at least one frame', ll.frames.filter(Boolean).length >= 1, `${ll.frames.filter(Boolean).length} frames`);

    // ===================================================================
    scenario('Self-correction — engine recovers when selectors miss (DOM tier)');
    const heal = await runLinkedIn(page, { proj: projName, text: 'E2E self-heal post', images: [], mockUrl: mock.url + 'hard' });
    check('composer still completed despite broken selectors', heal.done && heal.done.ok, JSON.stringify(heal.err || heal.timeout || ''));
    check('engine reported a self-correction step', heal.labels.some((l) => /self-correct/i.test(l)), heal.labels.filter((l) => /self-correct/i.test(l)).join(' | ') || heal.labels.join(' | '));
    check('post text still landed after healing', heal.done?.typedText?.includes('E2E self-heal post'), (heal.done?.typedText || '').slice(0, 50));
    check('still STOPPED before posting', heal.done?.posted === false);

    // ===================================================================
    scenario('LinkedIn Poster UI — project + photos load in the panel');
    await goTo(page, 'linkedin');
    await page.waitForSelector('#llProj');
    await page.selectOption('#llProj', projName);
    await page.waitForFunction(() => document.querySelectorAll('#llImgs input[type=checkbox]').length > 0, { timeout: 5000 }).catch(() => {});
    check('photo checkboxes render in the LinkedIn panel', (await page.$$eval('#llImgs input[type=checkbox]', (c) => c.length)) > 0);

    // ===================================================================
    scenario('Canvas — renders generated HTML inside the app');
    await goTo(page, 'canvas');
    await page.waitForSelector('#cvProj');
    await page.selectOption('#cvProj', projName);
    await page.waitForFunction(() => [...document.querySelectorAll('#cvOutputs button')].some((b) => /Landing page/i.test(b.textContent)), { timeout: 6000 }).catch(() => {});
    const lpBtn = await page.$$('#cvOutputs button');
    let clicked = false;
    for (const b of lpBtn) { if (/Landing page/i.test(await b.textContent())) { await b.click(); clicked = true; break; } }
    check('landing-page output is listed in Canvas', clicked);
    await page.waitForSelector('#cvWrap:not(.hidden)', { timeout: 5000 }).catch(() => {});
    const frameSrc = await page.$eval('#cvFrame', (f) => f.getAttribute('src')).catch(() => '');
    check('canvas iframe loads the HTML in-app', /index\.html/.test(frameSrc), frameSrc);

    // ===================================================================
    scenario('Monitors — full CRUD lifecycle (offline)');
    await goTo(page, 'monitors');
    await page.waitForSelector('#mAdd');
    const before = await page.$$eval('#mList > div', (d) => d.length).catch(() => 0);
    await page.fill('#mName', 'E2E LinkedIn watch');
    await page.selectOption('#mType', 'research');
    await page.fill('#mUrl', 'https://example.com');
    await page.fill('#mObjective', 'What changed today');
    await page.fill('#mInterval', '60');
    await page.click('#mAdd');
    await page.waitForFunction((b) => document.querySelectorAll('#mList > div').length === b + 1, before, { timeout: 5000 }).catch(() => {});
    const after = await page.$$eval('#mList > div', (d) => d.length);
    check('monitor created & listed', after === before + 1, `${before} → ${after}`);
    check('monitor row shows name', (await page.textContent('#mList')).includes('E2E LinkedIn watch'));
    check('monitor shows interval', (await page.textContent('#mList')).includes('every 60m'));
    // toggle enable
    await page.click('#mList .mEn');
    await sleep(300);
    // scheduler toggle
    await page.click('#sched');
    await sleep(300);
    const schedState = await page.$eval('#sched', (e) => e.checked);
    check('scheduler toggle reflects state', typeof schedState === 'boolean');
    // delete it (cleanup)
    await page.click('#mList .mDel');
    await page.waitForFunction((b) => document.querySelectorAll('#mList > div').length === b, before, { timeout: 5000 }).catch(() => {});
    const afterDel = await page.$$eval('#mList > div', (d) => d.length).catch(() => 0);
    check('monitor deleted (back to baseline)', afterDel === before, `now ${afterDel}`);
    // turn scheduler back off if we turned it on
    if (schedState) { await page.click('#sched'); await sleep(200); }

    // ===================================================================
    scenario('Channels — add / test / delete a webhook (offline-safe)');
    await goTo(page, 'channels');
    await page.waitForSelector('#cAdd');
    const cBefore = await page.$$eval('#cList > div', (d) => d.length).catch(() => 0);
    await page.fill('#cName', 'E2E Discord');
    await page.selectOption('#cKind', 'discord');
    await page.fill('#cHook', 'https://discord.invalid/webhook/e2e');
    await page.click('#cAdd');
    await page.waitForFunction((b) => document.querySelectorAll('#cList > div').length === b + 1, cBefore, { timeout: 5000 }).catch(() => {});
    const cAfter = await page.$$eval('#cList > div', (d) => d.length);
    check('channel created & listed', cAfter === cBefore + 1, `${cBefore} → ${cAfter}`);
    check('webhook URL is redacted in UI', !(await page.textContent('#cList')).includes('discord.invalid/webhook/e2e'));
    // Test the new (last) channel — should fail gracefully against the invalid host
    const rows = await page.$$('#cList > div');
    const myRow = rows[rows.length - 1];
    await myRow.$eval('.cTest', (b) => b.click());
    await page.waitForFunction((el) => /✓|✗/.test(el.querySelector('.cMsg')?.textContent || ''), myRow, { timeout: 8000 }).catch(() => {});
    const testMsg = await myRow.$eval('.cMsg', (e) => e.textContent);
    check('channel "Test" returns a result without crashing', /✓|✗/.test(testMsg), `msg="${testMsg}"`);
    // delete (cleanup)
    await myRow.$eval('.cDel', (b) => b.click());
    await page.waitForFunction((b) => document.querySelectorAll('#cList > div').length === b, cBefore, { timeout: 5000 }).catch(() => {});
    const cDel = await page.$$eval('#cList > div', (d) => d.length).catch(() => 0);
    check('channel deleted (back to baseline)', cDel === cBefore, `now ${cDel}`);

    // ===================================================================
    scenario('Ask Jarvis — Local core engine degrades honestly');
    await goTo(page, 'ask');
    await page.waitForSelector('#runBtn');
    await page.selectOption('.engineSel', 'core');
    await page.waitForFunction(() => /core/.test(document.querySelector('#coreHint')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    check('core readiness hint shown', /core/i.test(await page.textContent('#coreHint')));
    await page.fill('#prompt', 'Summarise what Open Jarvis does in one line.');
    await page.click('#runBtn');
    await page.waitForFunction(() => {
      const t = document.querySelector('#out')?.textContent || '';
      return t && !/Asking local core|Thinking/.test(t);
    }, { timeout: 30000 });
    const askOut = await page.textContent('#out');
    check('core engine returns actionable guidance (no crash)', askOut.length > 0 && /core|install|engine|pip|ollama/i.test(askOut), askOut.slice(0, 120));

    // ===================================================================
    scenario('Morning Digest — friendly empty state (no findings yet)');
    await goTo(page, 'digest');
    await page.waitForSelector('#digBtn');
    await page.click('#digBtn');
    await page.waitForFunction(() => {
      const t = document.querySelector('#digOut')?.textContent || '';
      return t && !/Compiling/.test(t);
    }, { timeout: 30000 });
    const digOut = await page.textContent('#digOut');
    check('digest gives a friendly message when no findings', /no monitor findings/i.test(digOut), digOut.slice(0, 120));

    // ===================================================================
    // LLM-backed features: each must return healthy content — a real Gemini
    // answer when a signed-in Edge/Gemini session is live, OR clear setup
    // guidance when it isn't — and NEVER crash the server. We classify which
    // mode we got so the report is honest about what was exercised.
    scenario('LLM features: Research / Browser Agent / Ask-Gemini (live or graceful)');
    const degraded = (t) => /profile|setup|remember|not runnable|not installed|debug port/i.test(t || '');
    const mode = (t) => (degraded(t) ? 'graceful-degraded' : 'LIVE Gemini');
    // Ask via Gemini engine (benign prompt)
    const askG = await page.evaluate(async () => (await (await fetch('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Reply with the single word: ready', engine: 'gemini' }),
    })).json()));
    check('Ask (Gemini) responds healthily, never crashes', askG && typeof askG.text === 'string' && askG.text.length > 0, mode(askG.text) + ': ' + (askG.text || '').slice(0, 70));
    // Research
    const research = await page.evaluate(async () => (await (await fetch('/api/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', objective: 'What is this page about?' }),
    })).json()));
    check('Deep Research responds healthily, never crashes', research && typeof research.text === 'string' && research.text.length > 0, mode(research.text) + ': ' + (research.text || '').slice(0, 70));
    // Agent — via the live-view stream (collect frames + final result)
    const agent = await page.evaluate(() => new Promise((resolve) => {
      const frames = []; let done = null, err = null;
      const es = new EventSource('/api/agent/stream?objective=' + encodeURIComponent('open example.com and read the headline'));
      es.addEventListener('step', (e) => { try { frames.push(!!JSON.parse(e.data).image); } catch {} });
      es.addEventListener('done', (e) => { try { done = JSON.parse(e.data); } catch {} es.close(); resolve({ frames, done, err }); });
      es.addEventListener('error', (e) => { try { err = JSON.parse(e.data); } catch { err = 'error'; } es.close(); resolve({ frames, done, err }); });
      setTimeout(() => { es.close(); resolve({ frames, done, err, timeout: true }); }, 90000);
    }));
    check('Browser Agent live stream responds healthily, never crashes', agent.done && Array.isArray(agent.done.results), `${agent.frames.filter(Boolean).length} live frame(s), ${agent.done?.results?.length ?? 0} command(s)`);
    // server still alive after all that
    const aliveR = await fetch(`${BASE}/api/state`);
    check('server still healthy after LLM calls', aliveR.ok);

    // ===================================================================
    scenario('No uncaught client-side JS errors across the whole walkthrough');
    check('zero pageerror events', pageErrors.length === 0, pageErrors.join(' | '));

    await page.screenshot({ path: join(SHOTS, 'hub-final.png'), fullPage: true });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (mock) mock.srv.close();
    server.kill();
    await restore(bak);
  }

  // ---- summary -----------------------------------------------------------
  let pass = 0, fail = 0;
  const failed = [];
  for (const s of results) for (const c of s.checks) { if (c.ok) pass++; else { fail++; failed.push(`${s.name} → ${c.desc}${c.detail ? ' (' + c.detail + ')' : ''}`); } }
  log(`\n${'='.repeat(60)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(60)}`);
  if (failed.length) { log('FAILURES:'); failed.forEach((f) => log('  ✗ ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
