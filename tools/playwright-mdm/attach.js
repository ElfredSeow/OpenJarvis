import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const DEFAULT_CDP_PORT = 9222;
const cdpEndpoint = (port = DEFAULT_CDP_PORT) => `http://127.0.0.1:${port}`;
const CDP_ENDPOINT = cdpEndpoint(DEFAULT_CDP_PORT); // back-compat default
const CDP_VERSION_URL = `${CDP_ENDPOINT}/json/version`;
const __dirname_attach = path.dirname(fileURLToPath(import.meta.url));

/** Ask the OS for a free TCP port (used when 9222 is occupied). */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function defaultDedicatedUserDataDir() {
  return path.join(__dirname_attach, '.jarvis-edge-profile');
}
const DEFAULT_EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export const BROWSER_CONFIGS = {
  chrome: {
    name: 'Google Chrome',
    executablePaths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    getLocalStatePath(env = process.env) {
      const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Local State');
    },
  },
  edge: {
    name: 'Microsoft Edge',
    executablePaths: DEFAULT_EDGE_PATHS,
    getLocalStatePath: getDefaultLocalStatePath,
  },
};

export function getDefaultLocalStatePath(env = process.env) {
  const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Local State');
}

export async function discoverEdgeProfiles(localStatePath = getDefaultLocalStatePath()) {
  const localState = JSON.parse(await readFile(localStatePath, 'utf8'));
  const infoCache = localState?.profile?.info_cache;

  if (!infoCache || typeof infoCache !== 'object') {
    return [];
  }

  return Object.entries(infoCache).map(([directory, metadata]) => {
    const profileMetadata = metadata && typeof metadata === 'object' ? metadata : {};

    return {
      directory,
      displayName: firstString(profileMetadata.name, profileMetadata.shortcut_name, directory),
      username: firstString(profileMetadata.user_name, profileMetadata.gaia_name, ''),
    };
  });
}

export function formatProfileLabel(profile) {
  const displayName = firstString(profile.displayName, profile.directory);
  const username = firstString(profile.username, '');
  const identity = username ? `${displayName} (${username})` : displayName;

  return `${profile.directory} - ${identity}`;
}

export function validateProfileSelection(selection, profiles) {
  const trimmedSelection = selection.trim();

  if (!trimmedSelection) {
    throw new Error('Enter a profile number to continue.');
  }

  const selectedNumber = Number(trimmedSelection);

  if (!Number.isInteger(selectedNumber) || selectedNumber < 1 || selectedNumber > profiles.length) {
    throw new Error(`Choose a number from 1 to ${profiles.length}.`);
  }

  return profiles[selectedNumber - 1];
}

export function validateTargetAppUrl(value) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error('Enter a valid http or https URL.');
  }

  try {
    const url = new URL(trimmedValue);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Unsupported protocol');
    }

    return url.href;
  } catch {
    throw new Error('Enter a valid http or https URL.');
  }
}

export function getEdgeExecutablePath() {
  const edgePath = DEFAULT_EDGE_PATHS.find((candidate) => existsSync(candidate));

  if (!edgePath) {
    throw new Error(`Microsoft Edge was not found. Checked: ${DEFAULT_EDGE_PATHS.join(', ')}`);
  }

  return edgePath;
}

export function buildEdgeLaunchArgs(profileDirectory, { port = DEFAULT_CDP_PORT, userDataDir } = {}) {
  const args = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--profile-directory=${profileDirectory}`,
  ];
  // A dedicated user-data-dir makes Edge start a SEPARATE instance (not blocked
  // by an already-running Edge), so its own debugging port can open.
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
  return args;
}

export async function isCdpEndpointAvailable(port = DEFAULT_CDP_PORT) {
  try {
    const response = await fetch(`${cdpEndpoint(port)}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForCdpEndpoint({ attempts = 20, delayMs = 500, port = DEFAULT_CDP_PORT } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isCdpEndpointAvailable(port)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return false;
}

export function launchEdgeWithProfile(profileDirectory, opts = {}) {
  const edgePath = getEdgeExecutablePath();
  const edgeProcess = spawn(edgePath, buildEdgeLaunchArgs(profileDirectory, opts), {
    detached: true,
    stdio: 'ignore',
  });

  edgeProcess.unref();
}

export function getExecutablePath(executablePaths) {
  const found = executablePaths.find((p) => existsSync(p));

  if (!found) {
    throw new Error(`Browser not found. Checked: ${executablePaths.join(', ')}`);
  }

  return found;
}

export function launchBrowserWithProfile(executablePath, profileDirectory) {
  const proc = spawn(executablePath, buildEdgeLaunchArgs(profileDirectory), {
    detached: true,
    stdio: 'ignore',
  });

  proc.unref();
}

export async function selectBrowser(input = process.stdin, output = process.stdout) {
  const entries = Object.entries(BROWSER_CONFIGS);
  const rl = readline.createInterface({ input, output });

  console.log('\nAvailable browsers:');
  entries.forEach(([, config], index) => {
    console.log(`${index + 1}. ${config.name}`);
  });

  try {
    for (;;) {
      const answer = await rl.question('Choose a browser number: ');
      const n = Number(answer.trim());

      if (Number.isInteger(n) && n >= 1 && n <= entries.length) {
        return entries[n - 1][1];
      }

      console.error(`Choose a number from 1 to ${entries.length}.`);
    }
  } finally {
    rl.close();
  }
}

export async function selectBrowserAndProfile(input = process.stdin, output = process.stdout) {
  const browserEntries = Object.entries(BROWSER_CONFIGS);
  const rl = readline.createInterface({ input, output });

  try {
    console.log('\nAvailable browsers:');
    browserEntries.forEach(([, c], i) => console.log(`${i + 1}. ${c.name}`));

    let browserConfig;
    for (;;) {
      const n = Number((await rl.question('Choose a browser number: ')).trim());
      if (Number.isInteger(n) && n >= 1 && n <= browserEntries.length) {
        browserConfig = browserEntries[n - 1][1];
        break;
      }
      console.error(`Choose a number from 1 to ${browserEntries.length}.`);
    }

    const localStatePath = browserConfig.getLocalStatePath();
    const profiles = await discoverEdgeProfiles(localStatePath);

    if (profiles.length === 0) {
      throw new Error(`No ${browserConfig.name} profiles found in ${localStatePath}.`);
    }

    console.log(`\nAvailable ${browserConfig.name} profiles:`);
    profiles.forEach((p, i) => console.log(`${i + 1}. ${formatProfileLabel(p)}`));

    for (;;) {
      const selection = await rl.question('Choose a profile number: ');
      try {
        return { browserConfig, profile: validateProfileSelection(selection, profiles) };
      } catch (e) {
        console.error(e.message);
      }
    }
  } finally {
    rl.close();
  }
}

export async function attachToEdge(endpoint = CDP_ENDPOINT) {
  const browser = await chromium.connectOverCDP(endpoint);
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());

  console.log('Successfully attached to Edge.');
  console.log(`Browser contexts: ${contexts.length}`);
  console.log(`Open pages: ${pages.length}`);

  if (pages.length === 0) {
    console.log('No open pages were reported by the CDP endpoint.');
    return { browser, contexts, pages };
  }

  for (const [index, page] of pages.entries()) {
    const title = await page.title();
    console.log(`${index + 1}. ${title || '(untitled)'} - ${page.url()}`);
  }

  return { browser, contexts, pages };
}

export function getAttachedBrowserContext(browser) {
  const [context] = browser.contexts();

  if (!context) {
    throw new Error('No browser context is available from the attached Edge session.');
  }

  return context;
}

/**
 * Acquire a CDP-attached browser, healing around a busy port:
 *   1. REUSE an existing CDP on the preferred port (the signed-in session).
 *   2. Else LAUNCH the remembered Edge profile on the preferred port.
 *   3. If that port is busy / Edge is already running, OPEN ANOTHER CDP on its
 *      own — a separate, Jarvis-owned Edge instance (its own user-data-dir) on a
 *      free port — so you never have to close your existing Edge.
 *
 * The browser/probe/launch/wait/free-port operations are injectable so the
 * decision ladder can be unit-tested without launching a real browser.
 *
 * @returns {{ browser, endpoint, port, mode:'reused'|'launched'|'dedicated' }}
 */
export async function acquireEdgeBrowser({
  profileDirectory,
  preferredPort = DEFAULT_CDP_PORT,
  dedicatedUserDataDir,
  onLog = () => {},
  probe = isCdpEndpointAvailable,
  launch = launchEdgeWithProfile,
  waitFor = waitForCdpEndpoint,
  attach = attachToEdge,
  freePort = findFreePort,
} = {}) {
  // 1 · REUSE — works even without a remembered profile.
  if (await probe(preferredPort)) {
    onLog(`Reusing existing CDP on port ${preferredPort}.`);
    const { browser } = await attach(cdpEndpoint(preferredPort));
    return { browser, endpoint: cdpEndpoint(preferredPort), port: preferredPort, mode: 'reused' };
  }

  if (!profileDirectory) {
    throw new Error('No Edge profile remembered yet — run setup once, or open Edge with --remote-debugging-port.');
  }

  // 2 · LAUNCH on the preferred port.
  onLog(`Launching Edge profile "${profileDirectory}" on port ${preferredPort}…`);
  launch(profileDirectory, { port: preferredPort });
  if (await waitFor({ port: preferredPort, attempts: 16, delayMs: 500 })) {
    const { browser } = await attach(cdpEndpoint(preferredPort));
    return { browser, endpoint: cdpEndpoint(preferredPort), port: preferredPort, mode: 'launched' };
  }

  // 3 · BUSY — open another CDP on its own (separate instance + free port).
  const port = await freePort();
  const userDataDir = dedicatedUserDataDir || defaultDedicatedUserDataDir();
  onLog(`Port ${preferredPort} is busy — opening a dedicated Edge CDP on port ${port}.`);
  launch(profileDirectory, { port, userDataDir });
  if (!(await waitFor({ port, attempts: 30, delayMs: 600 }))) {
    throw new Error(`Could not open a CDP endpoint on ${preferredPort} or fallback ${port}.`);
  }
  const { browser } = await attach(cdpEndpoint(port));
  return { browser, endpoint: cdpEndpoint(port), port, mode: 'dedicated' };
}

export async function runAppSmokeTest(context, targetUrl, { timeout = 30000 } = {}) {
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];

  page.on('pageerror', (error) => {
    pageErrors.push(error?.message ?? String(error));
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      errorText: request.failure()?.errorText ?? 'Request failed',
    });
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout });

    if (page.waitForLoadState) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    return {
      ok: true,
      targetUrl,
      finalUrl: page.url(),
      title: await page.title(),
      pageErrors,
      consoleErrors,
      failedRequests,
    };
  } catch (error) {
    return {
      ok: false,
      targetUrl,
      finalUrl: page.url(),
      title: await safePageTitle(page),
      error: error.message,
      pageErrors,
      consoleErrors,
      failedRequests,
    };
  }
}

export function formatSmokeTestReport(result) {
  const lines = [
    'App smoke test report:',
    `Status: ${result.ok ? 'navigation completed' : 'navigation failed'}`,
    `Target URL: ${result.targetUrl}`,
    `Final URL: ${result.finalUrl}`,
    `Title: ${result.title || '(untitled)'}`,
  ];

  if (result.error) {
    lines.push(`Navigation error: ${result.error}`);
  }

  appendSignalLines(lines, 'Page errors', result.pageErrors);
  appendSignalLines(lines, 'Console errors', result.consoleErrors);
  appendSignalLines(
    lines,
    'Failed requests',
    result.failedRequests.map((request) => `${request.url} - ${request.errorText}`),
  );

  if (
    result.ok &&
    result.pageErrors.length === 0 &&
    result.consoleErrors.length === 0 &&
    result.failedRequests.length === 0
  ) {
    lines.push('No basic browser-page issues were observed.');
  }

  return lines;
}

export async function selectProfile(profiles, input = process.stdin, output = process.stdout) {
  const prompt = readline.createInterface({ input, output });

  try {
    for (;;) {
      const selection = await prompt.question('Choose a profile number: ');

      try {
        return validateProfileSelection(selection, profiles);
      } catch (error) {
        console.error(error.message);
      }
    }
  } finally {
    prompt.close();
  }
}

export async function selectTargetAppUrl(input = process.stdin, output = process.stdout) {
  const prompt = readline.createInterface({ input, output });

  try {
    for (;;) {
      const value = await prompt.question('Enter target app URL: ');

      try {
        return validateTargetAppUrl(value);
      } catch (error) {
        output.write(`${error.message}\n`);
      }
    }
  } finally {
    prompt.close();
  }
}

export async function resolveTargetAppUrl(args = [], input = process.stdin, output = process.stdout) {
  const [targetUrl] = args;

  if (targetUrl) {
    return validateTargetAppUrl(targetUrl);
  }

  return selectTargetAppUrl(input, output);
}

export async function runAppUrlWorkflow(browser, args = process.argv.slice(2)) {
  const targetUrl = await resolveTargetAppUrl(args);
  const context = getAttachedBrowserContext(browser);
  const result = await runAppSmokeTest(context, targetUrl);

  for (const line of formatSmokeTestReport(result)) {
    console.log(line);
  }

  return result;
}

export async function run() {
  if (await isCdpEndpointAvailable()) {
    console.log(`Existing CDP endpoint detected at ${CDP_ENDPOINT}. Attaching without launching Edge.`);
    const { browser } = await attachToEdge();
    await runAppUrlWorkflow(browser);
    return;
  }

  const localStatePath = getDefaultLocalStatePath();
  const profiles = await discoverEdgeProfiles(localStatePath);

  if (profiles.length === 0) {
    throw new Error(`No Edge profiles were found in ${localStatePath}.`);
  }

  console.log('Available Microsoft Edge profiles:');
  profiles.forEach((profile, index) => {
    console.log(`${index + 1}. ${formatProfileLabel(profile)}`);
  });

  const selectedProfile = await selectProfile(profiles);

  console.log(`Launching Edge with profile directory: ${selectedProfile.directory}`);
  launchEdgeWithProfile(selectedProfile.directory);

  if (!(await waitForCdpEndpoint())) {
    throw new Error(
      `Edge launched, but ${CDP_ENDPOINT} did not become available. Fully close Edge, then run npm start again so Edge can relaunch with remote debugging enabled.`,
    );
  }

  const { browser } = await attachToEdge();
  await runAppUrlWorkflow(browser);
}

async function safePageTitle(page) {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

function appendSignalLines(lines, label, signals) {
  lines.push(`${label}: ${signals.length}`);

  signals.forEach((signal, index) => {
    lines.push(`  ${index + 1}. ${signal}`);
  });
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}