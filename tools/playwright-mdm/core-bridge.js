// core-bridge.js — the LOCAL engine: the real OpenJarvis `jarvis` CLI.
//
// Phase 2 of the Hub. Where the Gemini bridge rides your webapp license, this
// rides the local-first OpenJarvis core (Ollama / local models, agents, memory).
// It shells out to `jarvis ask --json` (or `python -m openjarvis.cli` from src
// when the console script isn't installed) and parses the JSON answer.
//
// Degrades honestly: if the CLI deps aren't installed or no engine is running,
// it returns actionable guidance rather than crashing or faking a reply.

import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC = join(REPO_ROOT, 'src');

const PY = process.env.JARVIS_PYTHON || 'python';

// Run a process, capture stdout/stderr. Resolves (never rejects).
function execCapture(cmd, args, { timeout = 120000, env } = {}) {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, ...env }, shell: false });
    } catch (e) {
      return resolveP({ spawnError: e.code || e.message, stdout: '', stderr: '', code: null });
    }
    let stdout = '', stderr = '';
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
    child.on('error', (e) => { clearTimeout(killer); resolveP({ spawnError: e.code || e.message, stdout, stderr, code: null }); });
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('close', (code) => { clearTimeout(killer); resolveP({ stdout, stderr, code }); });
  });
}

// Build the [cmd, args, opts] for a `jarvis` subcommand, preferring the
// installed console script and falling back to the module exec from src/.
async function coreInvoker() {
  // Is `jarvis` on PATH?
  const probe = await execCapture('jarvis', ['--version'], { timeout: 8000 });
  if (!probe.spawnError) return (subArgs) => ['jarvis', subArgs, {}];
  // Fall back to module exec with src on PYTHONPATH.
  return (subArgs) => [PY, ['-m', 'openjarvis.cli', ...subArgs], { env: { PYTHONPATH: SRC } }];
}

function classifyFailure(r) {
  const s = (r.stderr || '') + (r.stdout || '');
  if (r.spawnError === 'ENOENT') {
    return 'Local core not runnable: no `jarvis` command and no `python` on PATH.\n' +
      'Install the core: `pip install -e .` in the repo root.';
  }
  if (/ModuleNotFoundError|No module named/i.test(s)) {
    return 'Local core dependencies are not installed.\n' +
      'Run `pip install -e .` in the repo root (installs rich, click, httpx, …), then retry.';
  }
  if (/No inference engine available|Engine error|EngineConnection/i.test(s)) {
    return 'Local core is installed but no inference engine is running.\n' +
      'Start one — e.g. `ollama serve` and `ollama pull llama3.1` — or set OPENAI_API_KEY / ANTHROPIC_API_KEY, then retry.';
  }
  const tail = (r.stderr || r.stdout || 'unknown error').trim().split('\n').slice(-3).join('\n');
  return `Local core call failed (exit ${r.code}).\n${tail}`;
}

/** Ask the local core a question. Returns { text, engine, ok }. */
export async function coreAsk(prompt, { timeout = 120000 } = {}) {
  if (!prompt?.trim()) return { text: '(empty prompt)', engine: 'core', ok: false };
  const invoke = await coreInvoker();
  const [cmd, args, opts] = invoke(['ask', '--json', prompt]);
  const r = await execCapture(cmd, args, { ...opts, timeout });
  if (r.spawnError || r.code !== 0) return { text: classifyFailure(r), engine: 'core', ok: false };
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return { text: parsed.content ?? r.stdout.trim(), engine: 'core', ok: true };
  } catch {
    return { text: r.stdout.trim() || '(no output)', engine: 'core', ok: true };
  }
}

/** Honest status for the UI: can the core run, and is an engine reachable? */
export async function coreStatus() {
  const jarvis = await execCapture('jarvis', ['--version'], { timeout: 8000 });
  let cli = 'none', depsOk = false;
  if (!jarvis.spawnError) {
    cli = 'jarvis'; depsOk = true;
  } else {
    const dep = await execCapture(PY, ['-c', 'import rich, click, httpx, openjarvis'], { timeout: 12000, env: { PYTHONPATH: SRC } });
    if (!dep.spawnError && dep.code === 0) { cli = 'python-module'; depsOk = true; }
    else if (!dep.spawnError) cli = 'python-no-deps';
  }
  // Engine reachability (Ollama default endpoint + cloud keys)
  let engine = 'none';
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (res.ok) engine = 'ollama';
  } catch { /* not reachable */ }
  if (engine === 'none' && (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)) engine = 'cloud-key';

  const ready = depsOk && engine !== 'none';
  return { ready, cli, depsOk, engine };
}
