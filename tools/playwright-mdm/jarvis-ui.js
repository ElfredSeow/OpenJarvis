// jarvis-ui.js — the Open Jarvis Hub. A local web app (no terminal) that hosts
// many capabilities as modules: Ask, Marketing Studio, Deep Research, Browser
// Agent, Monitors, Settings. Engine is switchable per call: the Gemini
// Webapp-LLM bridge, or (Phase 2) the local OpenJarvis `jarvis` CLI.
//
//   npm run ui   ->  http://localhost:4100

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, normalize, extname, basename, dirname } from 'node:path';

import { scaffold, listProjects, projectDir, runProject, listProjectImages, WORKSPACE } from './jarvis.js';
import { discoverEdgeProfiles, formatProfileLabel, getDefaultLocalStatePath } from './attach.js';
import { loadConfig, saveConfig, LLM_PRESETS } from './config.js';
import { coreAsk, coreStatus } from './core-bridge.js';
import * as monitors from './monitors.js';
import * as channels from './channels.js';
import * as telegram from './telegram-bot.js';

// Digests/monitor alerts fan out to every enabled channel.
const notifyFn = (text) => channels.sendAll(text);

const PORT = Number(process.env.PORT) || 4100;

const OUTPUT_FILES = [
  { path: 'understanding/project-summary.md', label: 'Project summary' },
  { path: 'understanding/goals.md', label: 'Goals' },
  { path: 'understanding/audience.md', label: 'Audience' },
  { path: 'understanding/challenges.md', label: 'Challenges' },
  { path: 'marketing/linkedin/ideas/ideas.md', label: 'LinkedIn ideas' },
  { path: 'marketing/tiktok/ideas/ideas.md', label: 'TikTok ideas' },
  { path: 'landing-page/html/index.html', label: 'Landing page', preview: true },
  { path: 'video/storyboard/scene-01.html', label: 'Storyboard scene', preview: true },
];

const MIME = { '.html': 'text/html', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

// Lazy bridge import so the Hub boots without a configured browser.
let _bridge = null;
async function bridge() {
  if (!_bridge) _bridge = await import('./jarvis-bridge.js');
  return _bridge;
}

// Approve-all: copy every generated output into approvals/approved/, drop a
// manifest, and clear the pending review. Nothing leaves the machine.
async function approveAll(name) {
  const root = projectDir(name);
  if (!existsSync(root)) throw new Error('project not found');
  const approvedDir = join(root, 'approvals', 'approved');
  await mkdir(approvedDir, { recursive: true });
  const moved = [];
  for (const f of OUTPUT_FILES) {
    const src = join(root, f.path);
    if (!existsSync(src)) continue;
    const dst = join(approvedDir, f.path.replace(/[\\/]/g, '__'));
    await writeFile(dst, await readFile(src));
    moved.push(f.path);
  }
  await writeFile(join(approvedDir, 'APPROVED.md'),
    `# Approved — ${name}\n\nApproved ${new Date().toISOString()}.\n\n` + moved.map((m) => `- ${m}`).join('\n') + '\n');
  const pendingReview = join(root, 'approvals', 'pending', 'REVIEW.md');
  if (existsSync(pendingReview)) await rm(pendingReview).catch(() => {});
  return { approved: moved.length, items: moved };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/' && req.method === 'GET') return send(res, 200, PAGE, 'text/html');

    if (p === '/api/state' && req.method === 'GET') {
      const [projects, config, profiles] = await Promise.all([
        listProjects(), loadConfig(), discoverEdgeProfiles(getDefaultLocalStatePath()).catch(() => []),
      ]);
      return send(res, 200, {
        projects, config,
        profiles: profiles.map((pr) => ({ directory: pr.directory, label: formatProfileLabel(pr) })),
        llmPresets: LLM_PRESETS,
      });
    }

    if (p === '/api/setup' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.directory) return send(res, 400, { error: 'directory required' });
      const llm = b.llm?.url ? b.llm : (LLM_PRESETS[b.llmKey] ?? LLM_PRESETS.gemini);
      const saved = await saveConfig({ edgeProfile: { directory: b.directory, label: b.label ?? b.directory }, llm });
      return send(res, 200, { ok: true, config: saved });
    }

    if (p === '/api/project' && req.method === 'POST') {
      const b = await readBody(req);
      const name = (b.name ?? '').trim().replace(/[^\w.-]+/g, '-');
      if (!name) return send(res, 400, { error: 'name required' });
      await scaffold(name);
      return send(res, 200, { ok: true, projects: await listProjects(), dropFolder: join(projectDir(name), 'source') });
    }

    if (p === '/api/open-folder' && req.method === 'POST') {
      const b = await readBody(req);
      const target = join(projectDir(b.name ?? ''), 'source');
      if (!existsSync(target)) return send(res, 404, { error: 'project not found' });
      if (process.platform === 'win32') spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { ok: true, opened: target });
    }

    if (p === '/api/outputs' && req.method === 'GET') {
      const name = url.searchParams.get('project') ?? '';
      const root = projectDir(name);
      const list = [];
      for (const f of OUTPUT_FILES) {
        if (existsSync(join(root, f.path))) list.push({ ...f, url: `/files/${encodeURIComponent(name)}/${f.path}` });
      }
      const approved = existsSync(join(root, 'approvals', 'approved', 'APPROVED.md'));
      return send(res, 200, { outputs: list, approved });
    }

    if (p === '/api/approve' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, { ok: true, ...(await approveAll(b.project ?? '')) }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    // SSE pipeline run
    if (p === '/api/run' && req.method === 'GET') {
      const name = url.searchParams.get('project') ?? '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      emit('log', 'Starting…');
      try { emit('done', await runProject(name, { onLog: (line) => emit('log', line) })); }
      catch (e) { emit('error', e.message); }
      return res.end();
    }

    // Ask Jarvis — chat (engine switchable: local core or Gemini license)
    if (p === '/api/ask' && req.method === 'POST') {
      const b = await readBody(req);
      if ((b.engine ?? 'gemini') === 'core') return send(res, 200, await coreAsk(b.prompt ?? ''));
      try { const { askGemini } = await bridge(); return send(res, 200, { text: await askGemini(b.prompt ?? ''), engine: 'gemini' }); }
      catch (e) { return send(res, 200, { text: `⚠ ${e.message}`, error: true }); }
    }

    // Local core readiness (deps installed? engine running?)
    if (p === '/api/core-status' && req.method === 'GET') {
      return send(res, 200, await coreStatus());
    }

    // Deep Research — browser-powered
    if (p === '/api/research' && req.method === 'POST') {
      const b = await readBody(req);
      try { const { research } = await bridge(); return send(res, 200, { text: await research(b.url ?? '', b.objective ?? '') }); }
      catch (e) { return send(res, 200, { text: `⚠ ${e.message}`, error: true }); }
    }

    // Browser Agent — Gemini plans, Playwright executes
    if (p === '/api/agent' && req.method === 'POST') {
      const b = await readBody(req);
      try { const { act } = await bridge(); return send(res, 200, await act(b.objective ?? '')); }
      catch (e) { return send(res, 200, { plan: `⚠ ${e.message}`, results: [], error: true }); }
    }

    // Browser Agent (live) — streams a screen frame after each executed step.
    if (p === '/api/agent/stream' && req.method === 'GET') {
      const objective = url.searchParams.get('objective') ?? '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      try { const { actStream } = await bridge(); emit('done', await actStream(objective, { onStep: (s) => emit('step', s) })); }
      catch (e) { emit('error', e.message); }
      return res.end();
    }

    // ---- LinkedIn Poster (live) ----
    if (p === '/api/project-images' && req.method === 'GET') {
      return send(res, 200, { images: await listProjectImages(url.searchParams.get('project') ?? '') });
    }
    if (p === '/api/linkedin/post' && req.method === 'GET') {
      const name = url.searchParams.get('project') ?? '';
      const text = url.searchParams.get('text') ?? '';
      const keepOpen = url.searchParams.get('keep') !== '0';
      const targetUrl = url.searchParams.get('url') || undefined;
      let rels = [];
      try { rels = JSON.parse(url.searchParams.get('images') || '[]'); } catch { rels = []; }
      const root = projectDir(name);
      const images = [];
      for (const rel of Array.isArray(rels) ? rels : []) {
        const full = normalize(join(root, rel));
        if (full.startsWith(root) && existsSync(full)) images.push(full); // guard path escape
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      try {
        const { composeLinkedInPost } = await import('./linkedin.js');
        emit('done', await composeLinkedInPost({ text, images, url: targetUrl, keepOpen, onStep: (s) => emit('step', s) }));
      } catch (e) { emit('error', e.message); }
      return res.end();
    }

    // ---- Monitors (Phase 3) ----
    if (p === '/api/monitors' && req.method === 'GET')
      return send(res, 200, { monitors: await monitors.listMonitors(), schedulerEnabled: await monitors.getSchedulerEnabled() });
    if (p === '/api/monitors' && req.method === 'POST')
      return send(res, 200, await monitors.createMonitor(await readBody(req)));
    if (p === '/api/monitors/toggle' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await monitors.updateMonitor(b.id, { enabled: b.enabled })); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/monitors/delete' && req.method === 'POST') {
      await monitors.deleteMonitor((await readBody(req)).id); return send(res, 200, { ok: true });
    }
    if (p === '/api/monitors/run' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await monitors.runMonitor(b.id, { notifyFn })); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/monitors/results' && req.method === 'GET')
      return send(res, 200, { results: await monitors.listResults(url.searchParams.get('id') ?? '') });
    if (p === '/api/scheduler' && req.method === 'POST')
      return send(res, 200, { schedulerEnabled: await monitors.setSchedulerEnabled((await readBody(req)).enabled) });
    if (p === '/api/digest/run' && req.method === 'POST')
      return send(res, 200, await monitors.runDigest({ notifyFn }));

    // ---- Channels (Phase 4) ----
    if (p === '/api/channels' && req.method === 'GET') return send(res, 200, { channels: await channels.listChannels() });
    if (p === '/api/channels' && req.method === 'POST') {
      try { return send(res, 200, await channels.createChannel(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/channels/toggle' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await channels.toggleChannel(b.id, b.enabled)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/channels/delete' && req.method === 'POST') {
      await channels.deleteChannel((await readBody(req)).id); return send(res, 200, { ok: true });
    }
    if (p === '/api/channels/test' && req.method === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await channels.testChannel(b.id)); } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // ---- Telegram inbound (chat with Jarvis from your phone) ----
    if (p === '/api/telegram/status' && req.method === 'GET') return send(res, 200, telegram.telegramStatus());
    if (p === '/api/telegram/toggle' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.enabled) return send(res, 200, telegram.stopTelegram());
      const token = await channels.telegramToken();
      if (!token) return send(res, 400, { error: 'Add and enable a Telegram channel (with a bot token) first.' });
      const replyFn = async (text) => { const { askGemini } = await bridge(); return askGemini(text); };
      try { return send(res, 200, await telegram.startTelegram(token, { replyFn })); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    // Static monitor result files
    if (p.startsWith('/monitor-results/') && req.method === 'GET') {
      const rest = decodeURIComponent(p.slice('/monitor-results/'.length));
      const full = normalize(join(monitors.resultsRoot(), rest));
      if (!full.startsWith(monitors.resultsRoot())) return send(res, 403, { error: 'forbidden' });
      if (!existsSync(full) || !(await stat(full)).isFile()) return send(res, 404, { error: 'not found' });
      return send(res, 200, await readFile(full), 'text/markdown; charset=utf-8');
    }

    // Static workspace files (preview/download)
    if (p.startsWith('/files/') && req.method === 'GET') {
      const rest = decodeURIComponent(p.slice('/files/'.length));
      const slash = rest.indexOf('/');
      const name = rest.slice(0, slash);
      const rel = rest.slice(slash + 1);
      const full = normalize(join(projectDir(name), rel));
      if (!full.startsWith(projectDir(name))) return send(res, 403, { error: 'forbidden' });
      if (!existsSync(full) || !(await stat(full)).isFile()) return send(res, 404, { error: 'not found' });
      return send(res, 200, await readFile(full), MIME[extname(full).toLowerCase()] ?? 'application/octet-stream');
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\nOpen Jarvis Hub → http://localhost:${PORT}`);
  console.log(`Workspace: ${WORKSPACE}\n`);
});

// Opt-in scheduler: ticks every minute, only runs monitors when the master
// switch is on (off by default). Errors are swallowed so the Hub stays up.
setInterval(() => { monitors.runDue({ notifyFn }).catch(() => {}); }, 60_000);

// ---------------------------------------------------------------------------
// Single-page Hub UI (sidebar + module registry)
// ---------------------------------------------------------------------------
const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Open Jarvis Hub</title><script src="https://cdn.tailwindcss.com"></script>
<style>
  .navitem{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;font-size:13px;cursor:pointer;width:100%;text-align:left}
  .navitem.active{background:#0f2a22;color:#6ee7b7;border:1px solid #134e3a}
  .navitem.idle{color:#94a3b8;border:1px solid transparent}
  .navitem.idle:hover{background:#0f172a}
  .btn{font-size:13px;border-radius:10px;padding:8px 14px;font-weight:500;cursor:pointer;border:none}
  .ipt{width:100%;background:#020617;border:1px solid #334155;border-radius:10px;padding:8px 12px;font-size:13px;color:#e2e8f0}
</style></head>
<body class="bg-slate-950 text-slate-100">
<div class="flex min-h-screen">
  <!-- SIDEBAR -->
  <aside class="w-60 border-r border-slate-800 p-3 space-y-1 bg-[#040813] shrink-0">
    <div class="px-2 py-2 text-white font-bold">⚡ Jarvis Hub</div>
    <nav id="nav" class="space-y-1"></nav>
    <div class="absolute bottom-3 left-3 w-54 text-[11px] text-slate-500" id="statusBadge">…</div>
  </aside>
  <!-- CONTENT -->
  <main id="view" class="flex-1 p-7 max-w-4xl"></main>
</div>

<script>
const $ = (s, r=document) => r.querySelector(s);
let STATE = { projects: [], config: {}, profiles: [], llmPresets: {} };
let active = null; // active marketing project

const MODULES = [
  { id:'home',     icon:'🏠', label:'Dashboard',        render: renderHome },
  { id:'ask',      icon:'💬', label:'Ask Jarvis',       render: renderAsk },
  { id:'marketing',icon:'📣', label:'Marketing Studio', render: renderMarketing },
  { id:'linkedin', icon:'🔗', label:'LinkedIn Poster',  render: renderLinkedIn },
  { id:'canvas',   icon:'🖼️', label:'Canvas',           render: renderCanvas },
  { id:'research', icon:'🔎', label:'Deep Research',    render: renderResearch },
  { id:'agent',    icon:'🤖', label:'Browser Agent',    render: renderAgent },
  { id:'monitors', icon:'⏰', label:'Monitors',         render: renderMonitors },
  { id:'digest',   icon:'📰', label:'Morning Digest',   render: renderDigest },
  { id:'channels', icon:'🔌', label:'Channels',         render: renderChannels },
  { id:'settings', icon:'⚙️', label:'Settings',         render: renderSettings },
];

function renderNav(activeId){
  const nav = $('#nav'); nav.innerHTML='';
  MODULES.forEach(m=>{
    const b=document.createElement('button');
    b.className='navitem '+(m.id===activeId?'active':'idle');
    b.innerHTML='<span>'+m.icon+'</span><span>'+m.label+'</span>';
    b.onclick=()=>{location.hash=m.id;};
    nav.appendChild(b);
  });
}
function go(){
  const id=(location.hash||'#home').slice(1);
  const m=MODULES.find(x=>x.id===id)||MODULES[0];
  renderNav(m.id);
  $('#view').innerHTML='';
  m.render($('#view'));
}
function engineToggle(){
  return '<select class="ipt engineSel" style="width:auto"><option value="gemini">Engine: Gemini (license)</option><option value="core">Engine: Local core</option></select>';
}
async function post(path, body){ return (await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json(); }

// Live screen runner: open an SSE stream, swap the <img> on each frame, append
// step labels to a log. Used by the LinkedIn Poster and the Browser Agent.
function liveRun(streamUrl, opts){
  const img=opts.imgEl, logEl=opts.logEl;
  const add=t=>{ logEl.textContent+=t+'\\n'; logEl.scrollTop=logEl.scrollHeight; };
  const es=new EventSource(streamUrl);
  es.addEventListener('step', e=>{ const s=JSON.parse(e.data);
    if(s.image && img){ img.src='data:image/jpeg;base64,'+s.image; img.style.display='block'; }
    if(s.label) add('• '+s.label);
  });
  es.addEventListener('done', e=>{ add('✓ Done'); es.close(); let d={}; try{d=JSON.parse(e.data);}catch{} opts.onDone&&opts.onDone(d); });
  es.addEventListener('error', e=>{ let m='ended'; try{m=JSON.parse(e.data);}catch{} add('✗ '+m); es.close(); opts.onError&&opts.onError(m); });
  return es;
}

// ---- modules ----
function renderHome(v){
  const cfg=STATE.config.edgeProfile;
  v.innerHTML='<h1 class="text-2xl font-bold mb-1">Welcome to Jarvis</h1>'+
    '<p class="text-sm text-slate-400 mb-5">'+(cfg?('Connected · '+cfg.label+' · '+(STATE.config.llm?.name||'Gemini')):'Not set up yet — open Settings.')+'</p>'+
    '<div class="grid grid-cols-3 gap-3">'+MODULES.filter(m=>!['home'].includes(m.id)).map(m=>
      '<button class="bg-slate-900 border border-slate-800 hover:border-emerald-700 rounded-xl p-4 text-left" onclick="location.hash=\\''+m.id+'\\'">'+
      '<div class="text-2xl">'+m.icon+'</div><div class="text-sm text-white mt-2">'+m.label+'</div></button>').join('')+'</div>';
}

function chatModule(v, title, hint, fields, showEngine){
  v.innerHTML='<h1 class="text-2xl font-bold mb-1">'+title+'</h1><p class="text-sm text-slate-400 mb-4">'+hint+'</p>'+
    '<div class="space-y-2 mb-3">'+fields+'</div>'+
    '<div class="flex gap-2 items-center mb-2">'+(showEngine?engineToggle():'')+'<button class="btn bg-emerald-600 text-white" id="runBtn">Run</button></div>'+
    '<div id="coreHint" class="text-[11px] text-amber-300/80 mb-3"></div>'+
    '<pre id="out" class="text-xs bg-black/50 border border-slate-800 rounded-lg p-3 min-h-[160px] whitespace-pre-wrap text-slate-200"></pre>';
  return v;
}
function renderAsk(v){
  chatModule(v,'Ask Jarvis','General chat & reasoning. Switch engine: Gemini license (browser) or local core (Ollama).',
    '<textarea class="ipt" id="prompt" rows="3" placeholder="Ask anything…"></textarea>', true);
  const sel=$('.engineSel');
  const refreshHint=async()=>{
    if(sel.value!=='core'){$('#coreHint').textContent='';return;}
    $('#coreHint').textContent='Checking local core…';
    const s=await(await fetch('/api/core-status')).json();
    $('#coreHint').textContent=s.ready?('● local core ready ('+s.cli+' · '+s.engine+')')
      :('● local core not ready — cli:'+s.cli+' · engine:'+s.engine+'. It will return setup steps if you run.');
  };
  sel.onchange=refreshHint;
  $('#runBtn').onclick=async()=>{
    const out=$('#out'); out.textContent=sel.value==='core'?'Asking local core…':'Thinking…';
    const r=await post('/api/ask',{prompt:$('#prompt').value,engine:sel.value});
    out.textContent=r.text||'(no response)';
  };
}
function renderResearch(v){
  chatModule(v,'Deep Research','Open a page in a separate tab, analyse it with the LLM (browser-native).',
    '<input class="ipt" id="url" placeholder="https://… page to research">'+
    '<input class="ipt" id="objective" placeholder="What to find out (themes, goals, opportunities)">', false);
  $('#runBtn').onclick=async()=>{
    const out=$('#out'); out.textContent='Researching… (a browser tab will open)';
    const r=await post('/api/research',{url:$('#url').value,objective:$('#objective').value});
    out.textContent=r.text||'(no findings)';
  };
}
function renderAgent(v){
  v.innerHTML='<h1 class="text-2xl font-bold mb-1">Browser Agent</h1>'+
    '<p class="text-sm text-slate-400 mb-3">Describe a task; Gemini plans browser commands, Playwright runs them — and you watch the live screen.</p>'+
    '<textarea class="ipt mb-2" id="objective" rows="3" placeholder="e.g. open example.com and extract the headline"></textarea>'+
    '<button class="btn bg-emerald-600 text-white mb-3" id="runBtn">▶ Run with live view</button>'+
    '<div class="grid grid-cols-2 gap-3">'+
      '<div><div class="text-xs text-slate-400 mb-1 flex items-center gap-2">● Live screen</div>'+
        '<img id="agView" class="rounded-lg border border-slate-700 bg-black/60 w-full" style="display:none">'+
        '<div id="agEmpty" class="rounded-lg border border-slate-700 bg-black/60 h-40 flex items-center justify-center text-[11px] text-slate-500">live view appears here when you run</div></div>'+
      '<pre id="out" class="text-xs bg-black/50 border border-slate-800 rounded-lg p-3 min-h-[160px] whitespace-pre-wrap text-slate-200"></pre>'+
    '</div>';
  $('#runBtn').onclick=()=>{
    const obj=$('#objective').value; if(!obj.trim()) return;
    $('#out').textContent=''; $('#agEmpty').style.display='none';
    const btn=$('#runBtn'); btn.disabled=true; btn.textContent='⏳ Running…';
    liveRun('/api/agent/stream?objective='+encodeURIComponent(obj),{imgEl:$('#agView'),logEl:$('#out'),
      onDone:(d)=>{ btn.disabled=false; btn.textContent='▶ Run with live view'; $('#out').textContent+='\\n--- results ---\\n'+JSON.stringify(d.results||[],null,2); },
      onError:()=>{ btn.disabled=false; btn.textContent='▶ Run with live view'; }});
  };
}
async function renderMonitors(v){
  const s=await(await fetch('/api/monitors')).json();
  v.innerHTML='<div class="flex items-center justify-between mb-1"><h1 class="text-2xl font-bold">Monitors</h1>'+
    '<label class="text-xs text-slate-300 flex items-center gap-2"><input type="checkbox" id="sched" '+(s.schedulerEnabled?'checked':'')+'> Auto-run on schedule</label></div>'+
    '<p class="text-sm text-slate-400 mb-4">Recurring watchers run through Gemini and save findings. Runs only while the Hub is open. Auto-run drives the browser unattended — off by default; “Run now” is always manual.</p>'+
    '<div class="bg-slate-900 border border-slate-800 rounded-xl p-3 mb-4 grid grid-cols-2 gap-2">'+
      '<input class="ipt" id="mName" placeholder="Monitor name">'+
      '<select class="ipt" id="mType"><option value="research">Research a URL</option><option value="ask">Ask a prompt</option></select>'+
      '<input class="ipt" id="mUrl" placeholder="https://… (research)">'+
      '<input class="ipt" id="mObjective" placeholder="Objective / prompt">'+
      '<input class="ipt" id="mInterval" type="number" value="1440" title="interval minutes">'+
      '<button class="btn bg-sky-600 text-white" id="mAdd">+ Add monitor</button>'+
    '</div><div id="mList" class="space-y-2"></div>';
  $('#sched').onchange=async(e)=>{await post('/api/scheduler',{enabled:e.target.checked});};
  $('#mAdd').onclick=async()=>{
    await post('/api/monitors',{name:$('#mName').value,type:$('#mType').value,url:$('#mUrl').value,objective:$('#mObjective').value,prompt:$('#mObjective').value,intervalMinutes:$('#mInterval').value});
    renderMonitors(v);
  };
  const list=$('#mList');
  if(!s.monitors.length){list.innerHTML='<p class="text-slate-500 text-sm">No monitors yet.</p>';return;}
  s.monitors.forEach(m=>{
    const d=document.createElement('div'); d.className='bg-slate-900 border border-slate-800 rounded-xl p-3';
    d.innerHTML='<div class="flex items-center justify-between"><div><div class="text-sm text-white">'+m.name+
      ' <span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">'+m.type+'</span></div>'+
      '<div class="text-[11px] text-slate-500">every '+m.intervalMinutes+'m · '+(m.lastStatus?('last: '+m.lastStatus):'never run')+'</div></div>'+
      '<div class="flex gap-2 items-center"><label class="text-[11px] text-slate-400 flex items-center gap-1"><input type="checkbox" '+(m.enabled?'checked':'')+' class="mEn"> on</label>'+
      '<button class="btn bg-emerald-600 text-white mRun">Run now</button><button class="btn bg-rose-600/80 text-white mDel">✕</button></div></div>'+
      '<div class="mOut text-[11px] text-slate-300 mt-2 whitespace-pre-wrap"></div>';
    d.querySelector('.mEn').onchange=(e)=>post('/api/monitors/toggle',{id:m.id,enabled:e.target.checked});
    d.querySelector('.mDel').onclick=async()=>{await post('/api/monitors/delete',{id:m.id}); renderMonitors(v);};
    d.querySelector('.mRun').onclick=async()=>{const o=d.querySelector('.mOut'); o.textContent='Running… (browser opens)';
      const r=await post('/api/monitors/run',{id:m.id}); o.textContent=(r.text||'(done)').slice(0,800);};
    list.appendChild(d);
  });
}

function renderDigest(v){
  v.innerHTML='<h1 class="text-2xl font-bold mb-1">Morning Digest</h1>'+
    '<p class="text-sm text-slate-400 mb-4">Summarises the latest finding from every monitor into one skimmable brief (via Gemini), saved to workspace/digests and pushed to your channels.</p>'+
    '<button class="btn bg-emerald-600 text-white mb-3" id="digBtn">▶ Generate digest now</button>'+
    '<pre id="digOut" class="text-xs bg-black/50 border border-slate-800 rounded-lg p-3 min-h-[160px] whitespace-pre-wrap text-slate-200"></pre>';
  $('#digBtn').onclick=async()=>{const o=$('#digOut'); o.textContent='Compiling & summarising… (browser opens)';
    const r=await post('/api/digest/run',{}); o.textContent=r.text||'(no digest)';};
}

async function renderChannels(v){
  const s=await(await fetch('/api/channels')).json();
  v.innerHTML='<h1 class="text-2xl font-bold mb-1">Channels</h1>'+
    '<p class="text-sm text-slate-400 mb-4">Push digests & monitor alerts to Discord/Slack webhooks or a Telegram bot. Pure HTTP — no Python core needed.</p>'+
    '<div class="bg-slate-900 border border-slate-800 rounded-xl p-3 mb-4 grid grid-cols-2 gap-2">'+
      '<input class="ipt" id="cName" placeholder="Channel name">'+
      '<select class="ipt" id="cKind"><option value="discord">Discord webhook</option><option value="slack">Slack webhook</option><option value="telegram">Telegram bot</option></select>'+
      '<input class="ipt" id="cHook" placeholder="Webhook URL (Discord/Slack)">'+
      '<input class="ipt" id="cToken" placeholder="Telegram bot token (telegram)">'+
      '<input class="ipt" id="cChat" placeholder="Telegram chat id (telegram)">'+
      '<button class="btn bg-sky-600 text-white" id="cAdd">+ Add channel</button>'+
    '</div><div id="cList" class="space-y-2"></div>'+
    '<div class="bg-slate-900 border border-emerald-700/40 rounded-xl p-3 mt-4 flex items-center justify-between">'+
      '<div><div class="text-sm text-white">📱 Chat with Jarvis on Telegram</div>'+
      '<div class="text-[11px] text-slate-500">Inbound — messages to your bot get answered via Gemini. Needs an enabled Telegram channel. Drives the browser per message.</div></div>'+
      '<label class="text-xs text-slate-300 flex items-center gap-2"><input type="checkbox" id="tgListen"> Listen</label>'+
    '</div><div id="tgMsg" class="text-[11px] text-amber-300/80 mt-1"></div>';
  (async()=>{ const st=await(await fetch('/api/telegram/status')).json(); $('#tgListen').checked=st.running; })();
  $('#tgListen').onchange=async(e)=>{
    const r=await post('/api/telegram/toggle',{enabled:e.target.checked});
    if(r.error){ $('#tgMsg').textContent='⚠ '+r.error; e.target.checked=false; }
    else { $('#tgMsg').textContent=r.running?'● listening — message your bot now':'○ stopped'; }
  };
  $('#cAdd').onclick=async()=>{
    await post('/api/channels',{name:$('#cName').value,kind:$('#cKind').value,webhookUrl:$('#cHook').value,botToken:$('#cToken').value,chatId:$('#cChat').value});
    renderChannels(v);
  };
  const list=$('#cList');
  if(!s.channels.length){list.innerHTML='<p class="text-slate-500 text-sm">No channels yet.</p>';return;}
  s.channels.forEach(c=>{
    const d=document.createElement('div'); d.className='bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center justify-between';
    d.innerHTML='<div><div class="text-sm text-white">'+c.name+' <span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">'+c.kind+'</span></div>'+
      '<div class="text-[11px] text-slate-500">'+(c.webhookUrl||c.botToken||'')+'</div></div>'+
      '<div class="flex gap-2 items-center"><span class="cMsg text-[11px] text-slate-400"></span>'+
      '<label class="text-[11px] text-slate-400 flex items-center gap-1"><input type="checkbox" '+(c.enabled?'checked':'')+' class="cEn"> on</label>'+
      '<button class="btn bg-slate-700 text-white cTest">Test</button><button class="btn bg-rose-600/80 text-white cDel">✕</button></div>';
    d.querySelector('.cEn').onchange=(e)=>post('/api/channels/toggle',{id:c.id,enabled:e.target.checked});
    d.querySelector('.cDel').onclick=async()=>{await post('/api/channels/delete',{id:c.id}); renderChannels(v);};
    d.querySelector('.cTest').onclick=async()=>{const m=d.querySelector('.cMsg'); m.textContent='sending…';
      const r=await post('/api/channels/test',{id:c.id}); m.textContent=r.ok?'✓ sent':('✗ '+(r.status||r.error||'failed'));};
    list.appendChild(d);
  });
}

function renderMarketing(v){
  v.innerHTML='<h1 class="text-2xl font-bold mb-3">Marketing Studio</h1>'+
    '<div class="flex gap-2 mb-4"><input class="ipt" id="newName" placeholder="new-project-name" style="flex:1">'+
    '<button class="btn bg-sky-600 text-white" id="createBtn">Create</button></div>'+
    '<div id="projects" class="space-y-2 mb-5"></div>'+
    '<div id="studio" class="hidden space-y-3">'+
      '<div class="flex items-center justify-between"><div class="text-sm text-white">Project: <span id="activeProj" class="text-emerald-300"></span></div>'+
      '<div class="flex gap-2"><button class="btn bg-slate-700 text-white" id="openFolder">📁 Drop folder</button>'+
      '<button class="btn bg-emerald-600 text-white" id="runBtn">▶ Run pipeline</button></div></div>'+
      '<pre id="log" class="text-xs bg-black/50 border border-slate-800 rounded-lg p-3 h-44 overflow-y-auto whitespace-pre-wrap text-emerald-200"></pre>'+
      '<div><div class="text-xs font-semibold text-slate-300 mb-2">Outputs</div><div id="outputs" class="flex flex-wrap gap-2 text-xs"></div></div>'+
      '<div class="bg-slate-900 border border-amber-700/40 rounded-xl p-3 flex items-center justify-between">'+
      '<span class="text-xs text-slate-300" id="approveMsg">Approval gate — review outputs, then approve.</span>'+
      '<button class="btn bg-emerald-600 text-white" id="approveBtn">✓ Approve all</button></div>'+
    '</div>';
  renderProjects();
  $('#createBtn').onclick=async()=>{
    const name=$('#newName').value.trim(); if(!name) return;
    const r=await post('/api/project',{name}); STATE.projects=r.projects; $('#newName').value='';
    renderProjects(); selectProject(name.replace(/[^\\w.-]+/g,'-'));
  };
}
function renderProjects(){
  const box=$('#projects'); if(!box) return; box.innerHTML='';
  if(!STATE.projects.length){box.innerHTML='<p class="text-slate-500 text-sm">No projects yet.</p>';return;}
  STATE.projects.forEach(n=>{const b=document.createElement('button');
    b.className='block w-full text-left bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg px-3 py-2 text-sm';
    b.textContent=n; b.onclick=()=>selectProject(n); box.appendChild(b);});
}
function selectProject(name){
  active=name; $('#studio').classList.remove('hidden'); $('#activeProj').textContent=name;
  $('#log').textContent=''; loadOutputs();
  $('#openFolder').onclick=()=>post('/api/open-folder',{name});
  $('#approveBtn').onclick=async()=>{const r=await post('/api/approve',{project:name});
    $('#approveMsg').textContent=r.ok?('✓ Approved '+r.approved+' items → approvals/approved/'):('⚠ '+r.error);};
  $('#runBtn').onclick=()=>runPipeline(name);
}
async function loadOutputs(){
  const s=await(await fetch('/api/outputs?project='+encodeURIComponent(active))).json();
  const box=$('#outputs'); box.innerHTML='';
  if(!s.outputs.length){box.innerHTML='<span class="text-slate-500">none yet — run the pipeline</span>';return;}
  s.outputs.forEach(o=>{const a=document.createElement('a'); a.href=o.url; a.target='_blank';
    a.className='px-2.5 py-1.5 rounded-lg border '+(o.preview?'border-emerald-600 text-emerald-300':'border-slate-700 text-slate-300')+' hover:bg-slate-800';
    a.textContent=(o.preview?'🔎 ':'📄 ')+o.label; box.appendChild(a);});
}
function runPipeline(name){
  const log=$('#log'); log.textContent=''; const btn=$('#runBtn'); btn.disabled=true; btn.textContent='⏳ Running…';
  const es=new EventSource('/api/run?project='+encodeURIComponent(name));
  const add=t=>{log.textContent+=t+'\\n'; log.scrollTop=log.scrollHeight;};
  es.addEventListener('log',e=>add(JSON.parse(e.data)));
  es.addEventListener('done',()=>{add('✓ Done — review & approve below.'); es.close(); btn.disabled=false; btn.textContent='▶ Run pipeline'; loadOutputs();});
  es.addEventListener('error',e=>{try{add('✗ '+JSON.parse(e.data));}catch{add('✗ ended');} es.close(); btn.disabled=false; btn.textContent='▶ Run pipeline';});
}

function renderLinkedIn(v){
  v.innerHTML='<h1 class="text-2xl font-bold mb-1">LinkedIn Poster</h1>'+
    '<p class="text-sm text-slate-400 mb-4">Jarvis writes the post & attaches your photo references in your signed-in Edge, then stops at the Post button so <span class="text-emerald-300">you click Post</span>.</p>'+
    '<div class="grid grid-cols-2 gap-5">'+
      '<div class="space-y-3">'+
        '<select class="ipt" id="llProj"></select>'+
        '<div class="flex items-center justify-between"><span class="text-xs text-slate-400">Post text</span>'+
        '<button class="btn bg-slate-700 text-white" id="llLoad">⤓ Load from plan</button></div>'+
        '<textarea class="ipt" id="llText" rows="6" placeholder="Write your post (or load it from the plan)…"></textarea>'+
        '<div class="text-xs text-slate-400">Photo references</div>'+
        '<div id="llImgs" class="grid grid-cols-2 gap-2 text-[11px] text-slate-300"></div>'+
        '<button class="btn bg-emerald-600 text-white w-full" id="llRun">▶ Draft on LinkedIn (you press Post)</button>'+
        '<div id="llMsg" class="text-[11px] text-amber-300/80"></div>'+
      '</div>'+
      '<div class="space-y-2">'+
        '<div class="text-xs text-slate-400 flex items-center gap-2">● Live screen</div>'+
        '<img id="llView" class="rounded-lg border border-slate-700 bg-black/60 w-full" style="display:none">'+
        '<div id="llViewEmpty" class="rounded-lg border border-slate-700 bg-black/60 h-44 flex items-center justify-center text-[11px] text-slate-500">live view appears here when you run</div>'+
        '<pre id="llLog" class="text-[11px] bg-black/50 border border-slate-800 rounded-lg p-2 h-32 overflow-y-auto whitespace-pre-wrap text-emerald-200"></pre>'+
      '</div>'+
    '</div>';
  const proj=$('#llProj');
  if(!STATE.projects.length){ proj.innerHTML='<option value="">No projects — create one in Marketing Studio</option>'; }
  else STATE.projects.forEach(n=>{const o=document.createElement('option');o.value=n;o.textContent=n;proj.appendChild(o);});
  const loadImages=async()=>{
    const box=$('#llImgs'); if(!proj.value){box.innerHTML='';return;} box.innerHTML='<span class="text-slate-500">loading…</span>';
    const r=await(await fetch('/api/project-images?project='+encodeURIComponent(proj.value))).json();
    box.innerHTML='';
    if(!r.images||!r.images.length){ box.innerHTML='<span class="text-slate-500">No images yet — drop photos into the project\\'s source/ folder.</span>'; return; }
    r.images.forEach(p=>{const l=document.createElement('label'); l.className='ipt flex items-center gap-1';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.value=p; l.appendChild(cb); l.appendChild(document.createTextNode(' '+p)); box.appendChild(l);});
  };
  const loadText=async()=>{
    if(!proj.value){ $('#llMsg').textContent='Pick a project first.'; return; }
    try{ const res=await fetch('/files/'+encodeURIComponent(proj.value)+'/marketing/linkedin/ideas/ideas.md');
      if(res.ok){ $('#llText').value=await res.text(); $('#llMsg').textContent='Loaded marketing/linkedin/ideas/ideas.md — edit before drafting.'; }
      else $('#llMsg').textContent='No plan text yet (run the Marketing pipeline first), or just type your post.';
    }catch{ $('#llMsg').textContent=''; }
  };
  proj.onchange=loadImages;
  $('#llLoad').onclick=loadText;
  if(proj.value) loadImages();
  $('#llRun').onclick=()=>{
    const imgs=Array.from(document.querySelectorAll('#llImgs input:checked')).map(c=>c.value);
    const text=$('#llText').value;
    if(!proj.value){ $('#llMsg').textContent='Pick a project first.'; return; }
    if(!text.trim()){ $('#llMsg').textContent='Write some post text first.'; return; }
    $('#llLog').textContent=''; $('#llViewEmpty').style.display='none';
    const btn=$('#llRun'); btn.disabled=true; btn.textContent='⏳ Drafting… watch the live screen';
    const q='/api/linkedin/post?project='+encodeURIComponent(proj.value)+'&text='+encodeURIComponent(text)+'&images='+encodeURIComponent(JSON.stringify(imgs));
    liveRun(q,{imgEl:$('#llView'),logEl:$('#llLog'),
      onDone:(d)=>{ btn.disabled=false; btn.textContent='▶ Draft on LinkedIn (you press Post)';
        $('#llMsg').textContent=d.ok?('✓ Composer ready in Edge — review and click Post. ('+(d.imageCount||0)+' image(s) attached)'):('⚠ '+(d.error||'failed')); },
      onError:(m)=>{ btn.disabled=false; btn.textContent='▶ Draft on LinkedIn (you press Post)'; $('#llMsg').textContent='⚠ '+m; }});
  };
}

async function renderCanvas(v){
  v.innerHTML='<h1 class="text-2xl font-bold mb-1">Canvas</h1>'+
    '<p class="text-sm text-slate-400 mb-4">View any HTML Jarvis created — landing pages, storyboards — rendered right here.</p>'+
    '<div class="flex gap-2 mb-3 items-center flex-wrap"><select class="ipt" id="cvProj" style="max-width:240px"></select>'+
      '<div id="cvOutputs" class="flex flex-wrap gap-2 text-xs items-center"></div></div>'+
    '<div id="cvWrap" class="hidden rounded-xl border border-slate-700 overflow-hidden">'+
      '<div class="bg-[#0b1220] border-b border-slate-800 px-3 py-1.5 flex items-center justify-between">'+
      '<span class="text-xs text-slate-300" id="cvTitle">Canvas</span>'+
      '<span class="flex gap-2"><a class="btn bg-slate-700 text-white" id="cvOpen" target="_blank">Open in tab</a>'+
      '<button class="btn bg-rose-600/80 text-white" id="cvClose">Close</button></span></div>'+
      '<iframe id="cvFrame" class="w-full bg-white" style="height:62vh" sandbox="allow-scripts allow-popups"></iframe>'+
    '</div>';
  const proj=$('#cvProj');
  if(!STATE.projects.length){ proj.innerHTML='<option value="">No projects yet</option>'; $('#cvOutputs').innerHTML='<span class="text-slate-500">Create a project and run the pipeline first.</span>'; return; }
  STATE.projects.forEach(n=>{const o=document.createElement('option');o.value=n;o.textContent=n;proj.appendChild(o);});
  function showCanvas(u,label){ $('#cvTitle').textContent='🖼️ '+label; $('#cvFrame').src=u; $('#cvOpen').href=u; $('#cvWrap').classList.remove('hidden'); }
  const loadOuts=async()=>{
    const box=$('#cvOutputs'); box.innerHTML='<span class="text-slate-500">loading…</span>';
    const s=await(await fetch('/api/outputs?project='+encodeURIComponent(proj.value))).json();
    box.innerHTML='';
    if(!s.outputs||!s.outputs.length){ box.innerHTML='<span class="text-slate-500">No outputs yet — run the Marketing pipeline.</span>'; return; }
    s.outputs.forEach(o=>{const btn=document.createElement('button');
      btn.className='px-2.5 py-1.5 rounded-lg border '+(o.preview?'border-emerald-600 text-emerald-300':'border-slate-700 text-slate-300')+' hover:bg-slate-800';
      btn.textContent=(o.preview?'🖼️ ':'📄 ')+o.label;
      btn.onclick=()=>showCanvas(o.url,o.label); box.appendChild(btn);});
  };
  $('#cvClose').onclick=()=>{ $('#cvWrap').classList.add('hidden'); $('#cvFrame').src='about:blank'; };
  proj.onchange=loadOuts;
  loadOuts();
}

function renderSettings(v){
  const cfg=STATE.config;
  v.innerHTML='<h1 class="text-2xl font-bold mb-3">Settings</h1>'+
    '<div class="space-y-3 max-w-md">'+
    '<div><div class="text-xs text-slate-300 mb-1">Edge profile to drive</div><select class="ipt" id="profile"></select></div>'+
    '<div><div class="text-xs text-slate-300 mb-1">Webapp that powers Jarvis</div><select class="ipt" id="llm"></select></div>'+
    '<button class="btn bg-emerald-600 text-white" id="saveCfg">Remember this</button>'+
    '<p class="text-[11px] text-slate-500">Saved to jarvis-mdm.config.json — the bridge auto-launches this profile. Close Edge first so Jarvis owns a clean session.</p>'+
    '</div>';
  const prof=$('#profile'); STATE.profiles.forEach(p=>{const o=document.createElement('option');o.value=p.directory;o.dataset.label=p.label;o.textContent=p.label;prof.appendChild(o);});
  if(cfg.edgeProfile) prof.value=cfg.edgeProfile.directory;
  const llm=$('#llm'); Object.entries(STATE.llmPresets).forEach(([k,val])=>{const o=document.createElement('option');o.value=k;o.textContent=val.name+'  ('+val.url+')';llm.appendChild(o);});
  $('#saveCfg').onclick=async()=>{const o=prof.selectedOptions[0];
    const r=await post('/api/setup',{directory:o.value,label:o.dataset.label,llmKey:llm.value});
    STATE.config=r.config; updateBadge(); $('#saveCfg').textContent='✓ Saved';};
}
function updateBadge(){
  const c=STATE.config.edgeProfile;
  $('#statusBadge').textContent=c?('● '+c.label.split(' (')[0]+' · '+(STATE.config.llm?.name||'Gemini')):'● not set up';
}

async function boot(){
  STATE=await(await fetch('/api/state')).json();
  updateBadge();
  window.addEventListener('hashchange',go);
  go();
}
boot();
</script>
</body></html>`;
