// monitors.js — Phase 3. Recurring watchers that run through the Gemini engine
// (no Ollama needed) and save findings to the workspace. Also powers the
// Morning Digest (a summary over recent findings).
//
// Scheduling is opt-in and in-process: monitors only tick while the Hub is
// running, and the master scheduler is OFF by default — auto-driving the
// browser unattended is a deliberate choice, so you turn it on explicitly.
// "Run now" is always available and fully manual.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const STORE = join(__dirname, 'monitors.json');
const RESULTS_DIR = join(REPO_ROOT, 'workspace', 'monitors');
const DIGEST_DIR = join(REPO_ROOT, 'workspace', 'digests');

const DEFAULT_STORE = { schedulerEnabled: false, monitors: [] };

async function load() {
  if (!existsSync(STORE)) return { ...DEFAULT_STORE };
  try { return { ...DEFAULT_STORE, ...JSON.parse(await readFile(STORE, 'utf8')) }; }
  catch { return { ...DEFAULT_STORE }; }
}
async function save(data) { await writeFile(STORE, JSON.stringify(data, null, 2), 'utf8'); return data; }

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export async function listMonitors() { return (await load()).monitors; }
export async function getSchedulerEnabled() { return (await load()).schedulerEnabled; }

export async function setSchedulerEnabled(on) {
  const d = await load(); d.schedulerEnabled = !!on; await save(d); return d.schedulerEnabled;
}

export async function createMonitor({ name, type = 'research', url = '', objective = '', prompt = '', intervalMinutes = 1440, notify = true }) {
  const d = await load();
  const m = {
    id: uid(), name: (name || 'Untitled monitor').trim(), type, url, objective, prompt,
    intervalMinutes: Math.max(5, Number(intervalMinutes) || 1440),
    notify: !!notify, enabled: false, lastRun: null, lastStatus: null, nextRun: null,
  };
  d.monitors.push(m); await save(d); return m;
}

export async function updateMonitor(id, patch) {
  const d = await load(); const m = d.monitors.find((x) => x.id === id);
  if (!m) throw new Error('monitor not found');
  Object.assign(m, patch);
  if ('enabled' in patch && patch.enabled && !m.nextRun) m.nextRun = Date.now(); // run on next tick
  await save(d); return m;
}
export async function deleteMonitor(id) {
  const d = await load(); d.monitors = d.monitors.filter((x) => x.id !== id); await save(d);
}

// --- running ---------------------------------------------------------------
async function bridge() { return import('./jarvis-bridge.js'); }

async function saveResult(id, name, text) {
  const dir = join(RESULTS_DIR, id);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}.md`);
  await writeFile(file, `# ${name}\n\n_${new Date().toISOString()}_\n\n${text}\n`, 'utf8');
  return file;
}

/** Run one monitor now via the Gemini engine. Returns { ok, text, file }. */
export async function runMonitor(id, { notifyFn } = {}) {
  const d = await load();
  const m = d.monitors.find((x) => x.id === id);
  if (!m) throw new Error('monitor not found');
  let text = '', ok = true;
  try {
    const b = await bridge();
    if (m.type === 'research') text = await b.research(m.url, m.objective || 'Summarise what changed and why it matters.');
    else text = await b.askGemini(m.prompt || m.objective || m.name);
  } catch (e) { ok = false; text = `⚠ ${e.message}`; }

  const file = await saveResult(m.id, m.name, text);
  m.lastRun = Date.now();
  m.lastStatus = ok ? 'ok' : 'error';
  m.nextRun = Date.now() + m.intervalMinutes * 60_000;
  await save(d);
  if (ok && m.notify && typeof notifyFn === 'function') await notifyFn(`📡 ${m.name}\n\n${text.slice(0, 1500)}`).catch(() => {});
  return { ok, text, file };
}

export async function listResults(id, limit = 10) {
  const dir = join(RESULTS_DIR, id);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, limit);
  return files.map((f) => ({ name: f, url: `/monitor-results/${id}/${f}` }));
}
export function resultsRoot() { return RESULTS_DIR; }

/** Scheduler tick: run any enabled, due monitors. Guarded against overlap. */
let _ticking = false;
export async function runDue({ notifyFn } = {}) {
  if (_ticking) return { skipped: true };
  const d = await load();
  if (!d.schedulerEnabled) return { disabled: true };
  _ticking = true;
  const ran = [];
  try {
    const now = Date.now();
    for (const m of d.monitors) {
      if (m.enabled && (m.nextRun ?? 0) <= now) {
        try { await runMonitor(m.id, { notifyFn }); ran.push(m.id); } catch { /* keep going */ }
      }
    }
  } finally { _ticking = false; }
  return { ran };
}

// --- Morning Digest --------------------------------------------------------
/** Summarise the latest finding from each monitor into one digest via Gemini. */
export async function runDigest({ notifyFn } = {}) {
  const d = await load();
  const parts = [];
  for (const m of d.monitors) {
    const dir = join(RESULTS_DIR, m.id);
    if (!existsSync(dir)) continue;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort().reverse();
    if (!files.length) continue;
    const latest = await readFile(join(dir, files[0]), 'utf8');
    parts.push(`### ${m.name}\n${latest.slice(0, 2000)}`);
  }
  if (!parts.length) return { ok: false, text: 'No monitor findings yet — run some monitors first.' };

  let text = '', ok = true;
  try {
    const { askGemini } = await bridge();
    text = await askGemini(
      'You are Open Jarvis. Write a concise "Morning Digest" from the monitor findings below: ' +
      'top 3-5 takeaways, anything urgent, and suggested actions. Keep it skimmable.\n\n' + parts.join('\n\n'),
    );
  } catch (e) { ok = false; text = `⚠ ${e.message}`; }

  await mkdir(DIGEST_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = join(DIGEST_DIR, `${date}.md`);
  await writeFile(file, `# Morning Digest — ${date}\n\n${text}\n`, 'utf8');
  if (ok && typeof notifyFn === 'function') await notifyFn(`📰 Morning Digest ${date}\n\n${text.slice(0, 1800)}`).catch(() => {});
  return { ok, text, file };
}
export function digestRoot() { return DIGEST_DIR; }
