// jarvis.js — the end-user entry point for Open Jarvis (CLI + importable core).
//
// Scaffolds a project workspace (with a clear "drop your repo/files here" folder)
// and runs the project -> marketing pipeline through your remembered Gemini
// Webapp license. Outputs stop at the human APPROVAL gate.
//
//   node jarvis.js new   <project>     # create a project + drop folder
//   node jarvis.js run   <project>     # ingest -> interpret -> plan -> draft
//   node jarvis.js list                # list projects
//   node jarvis.js where <project>     # print the drop folder path
//
// The same functions are exported for the web UI (jarvis-ui.js).

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');
export const WORKSPACE = join(REPO_ROOT, 'workspace');
export const PROJECTS = join(WORKSPACE, 'projects');

// Folder scaffold (mirrors the Open Jarvis Architecture Plan)
const PROJECT_TREE = [
  'source/repo-clone', 'source/notes', 'source/raw-html',
  'understanding',
  'marketing/linkedin/ideas', 'marketing/linkedin/drafts', 'marketing/linkedin/approved', 'marketing/linkedin/published',
  'marketing/tiktok/ideas', 'marketing/tiktok/storyboards', 'marketing/tiktok/scripts', 'marketing/tiktok/approved', 'marketing/tiktok/published',
  'landing-page/brief', 'landing-page/html', 'landing-page/tests', 'landing-page/revisions',
  'video/storyboard', 'video/html-screens', 'video/scripts', 'video/remotion', 'video/renders',
  'research/linkedin-monitoring', 'research/competitors', 'research/observations',
  'approvals/pending', 'approvals/approved', 'approvals/rejected',
];

const TEXT_EXT = new Set(['.md', '.txt', '.html', '.htm', '.json', '.js', '.ts', '.py', '.toml', '.yml', '.yaml', '.css']);

export function projectDir(name) {
  return join(PROJECTS, name);
}

export async function scaffold(name) {
  const root = projectDir(name);
  for (const sub of PROJECT_TREE) await mkdir(join(root, sub), { recursive: true });
  const dropReadme = join(root, 'source', 'DROP FILES HERE.md');
  if (!existsSync(dropReadme)) {
    await writeFile(
      dropReadme,
      `# Drop your project material here\n\n` +
        `Put whatever describes your product into these folders, then run the pipeline.\n\n` +
        `- **repo-clone/** — clone or copy your code repo here (\`git clone <url> repo-clone\`).\n` +
        `- **notes/** — any .md / .txt notes, briefs, feature lists, positioning.\n` +
        `- **raw-html/** — existing pages, exports, or HTML you want considered.\n\n` +
        `Jarvis reads the text from these folders to understand the project.\n`,
      'utf8',
    );
  }
  return root;
}

export async function listProjects() {
  if (!existsSync(PROJECTS)) return [];
  return (await readdir(PROJECTS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
}

export async function collectSourceText(root, { maxFiles = 40, maxChars = 14000 } = {}) {
  const sourceDir = join(root, 'source');
  const chunks = [];
  let total = 0;
  async function walk(dir, depth = 0) {
    if (depth > 4 || total >= maxChars || chunks.length >= maxFiles) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (total >= maxChars || chunks.length >= maxFiles) break;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build'].includes(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.name === 'DROP FILES HERE.md') {
        continue; // the scaffold's own instructions are not project source
      } else if (TEXT_EXT.has(extname(e.name).toLowerCase())) {
        try {
          const s = await stat(full);
          if (s.size > 200_000) continue;
          let text = await readFile(full, 'utf8');
          const budget = maxChars - total;
          if (text.length > budget) text = text.slice(0, budget);
          chunks.push(`\n----- FILE: ${relative(sourceDir, full)} -----\n${text}`);
          total += text.length;
        } catch { /* skip unreadable */ }
      }
    }
  }
  await walk(sourceDir);
  return chunks.join('\n');
}

/**
 * Run the pipeline. Emits progress via onLog(line). Returns { reviewPath, outputs }.
 * Throws on missing project / no source / pipeline error.
 */
export async function runProject(name, { onLog = () => {} } = {}) {
  const root = projectDir(name);
  if (!existsSync(root)) throw new Error(`Project "${name}" not found. Create it first.`);

  onLog(`[1/5] Ingesting source for "${name}"...`);
  const source = await collectSourceText(root);
  if (!source.trim()) {
    throw new Error('No readable source found in source/. Drop your repo/notes/HTML there first.');
  }
  onLog(`  collected ${source.length} chars of source text.`);

  const { askGemini, dispose } = await import('./jarvis-bridge.js');
  const outputs = [];
  const write = async (relPath, content) => {
    const out = join(root, relPath);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, content, 'utf8');
    outputs.push(relPath);
    onLog(`  wrote ${relPath}`);
  };
  const ask = (label, prompt) => {
    onLog(`  · ${label}...`);
    return askGemini(`${prompt}\n\n=== PROJECT SOURCE ===\n${source}`);
  };

  try {
    onLog('[2/5] Interpreting project...');
    await write('understanding/project-summary.md', await ask('summary', 'Write a concise project-summary.md (what this product is, who it is for, the core value).'));
    await write('understanding/goals.md', await ask('goals', 'Write goals.md — the marketing goals this product should pursue.'));
    await write('understanding/audience.md', await ask('audience', 'Write audience.md — the target audiences and what they care about.'));
    await write('understanding/challenges.md', await ask('challenges', 'Write challenges.md — messaging challenges/objections to overcome.'));

    onLog('[3/5] Planning content...');
    await write('marketing/linkedin/ideas/ideas.md', await ask('linkedin', 'Propose 5 LinkedIn post ideas (hook + angle + CTA each) as markdown.'));
    await write('marketing/tiktok/ideas/ideas.md', await ask('tiktok', 'Propose 5 short-form TikTok video ideas (hook + beats + CTA each) as markdown.'));

    onLog('[4/5] Drafting deliverables...');
    await write('landing-page/html/index.html', await ask('landing page', 'Generate a complete, self-contained landing page as a single HTML file using Tailwind via CDN (hero, features, CTA). Output ONLY the HTML.'));
    await write('video/storyboard/scene-01.html', await ask('storyboard', 'Generate ONE storyboard scene as a single HTML file: title, intent, on-screen text, voiceover, CTA, transition notes. Output ONLY the HTML.'));

    onLog('[5/5] Staging for approval...');
    await write('approvals/pending/REVIEW.md',
      `# Review queue for ${name}\n\nGenerated ${new Date().toISOString()}.\n\n` +
        `Review these, then move approved items into approvals/approved/:\n\n` +
        `- understanding/*.md\n- marketing/linkedin/ideas/ideas.md\n- marketing/tiktok/ideas/ideas.md\n` +
        `- landing-page/html/index.html\n- video/storyboard/scene-01.html\n\n` +
        `Nothing is published until you approve.\n`);

    onLog('Done.');
    return { reviewPath: join(root, 'approvals', 'pending', 'REVIEW.md'), outputs };
  } finally {
    if (dispose) await dispose().catch(() => {});
  }
}

// --------------------------------------------------------------------------
// CLI (only when invoked directly, so the UI can import without side effects)
// --------------------------------------------------------------------------
function help() {
  console.log(`Open Jarvis

  node jarvis.js new   <project>   Create a project + "drop files here" folder
  node jarvis.js where <project>   Show where to drop your repo/files
  node jarvis.js run   <project>   Ingest -> interpret -> plan -> draft (stops at approval)
  node jarvis.js list              List projects

Workspace: ${WORKSPACE}`);
}

async function cli() {
  const [cmd, name] = process.argv.slice(2);
  switch (cmd) {
    case 'new': {
      if (!name) return help();
      const root = await scaffold(name);
      console.log(`\n✓ Created project "${name}".`);
      console.log(`\nDrop your repo/files here:\n  ${join(root, 'source')}`);
      console.log(`  • repo-clone/ → your code   • notes/ → briefs   • raw-html/ → existing pages`);
      console.log(`\nThen run:\n  node jarvis.js run ${name}`);
      break;
    }
    case 'where':
      if (!name) return help();
      console.log(join(projectDir(name), 'source'));
      break;
    case 'run':
      try { await runProject(name, { onLog: (l) => console.log(l) }); }
      catch (e) { console.error('\n' + e.message); process.exitCode = 1; }
      break;
    case 'list': {
      const ps = await listProjects();
      console.log(ps.length ? 'Projects:\n' + ps.map((p) => '  - ' + p).join('\n') : 'No projects yet. Create one: node jarvis.js new <project>');
      break;
    }
    default: help();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
