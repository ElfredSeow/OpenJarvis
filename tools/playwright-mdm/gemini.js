import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import {
  BROWSER_CONFIGS,
  attachToEdge,
  discoverEdgeProfiles,
  formatProfileLabel,
  getAttachedBrowserContext,
  getExecutablePath,
  isCdpEndpointAvailable,
  launchBrowserWithProfile,
  selectProfile,
  waitForCdpEndpoint,
} from './attach.js';

const GEMINI_URL = 'https://gemini.google.com';

// Update these if the Gemini webapp changes its DOM structure
const SEL = {
  input: 'rich-textarea .ql-editor[contenteditable="true"]',
  send: 'button[aria-label="Send message"]',
  stop: 'button[aria-label="Stop response"]',
  response: 'model-response',
};

export async function navigateToGemini(page, { timeout = 30000, url = GEMINI_URL } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForSelector(SEL.input, { timeout });
}

export async function sendPrompt(page, text) {
  const input = page.locator(SEL.input);
  await input.click();
  await page.keyboard.press('Control+a');

  // Type line-by-line so \n doesn't accidentally submit (Enter sends in Gemini's input)
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Shift+Enter');
    if (lines[i]) await page.keyboard.type(lines[i]);
  }

  await page.keyboard.press('Enter');
}

export async function waitForResponseComplete(page, { timeout = 120000 } = {}) {
  // Give streaming a moment to start; a very fast response may skip the stop button entirely
  try {
    await page.waitForSelector(SEL.stop, { timeout: 5000 });
  } catch {
    // Response may have already completed before the stop button appeared
  }
  await page.waitForSelector(SEL.stop, { state: 'hidden', timeout });
}

export async function stopResponse(page) {
  try {
    const stopBtn = page.locator(SEL.stop);
    if (await stopBtn.isVisible({ timeout: 2000 })) {
      await stopBtn.click();
      await page.waitForSelector(SEL.stop, { state: 'hidden', timeout: 8000 });
    }
  } catch {
    // already stopped or not visible
  }
}

// Strip Gemini webapp chrome that leaks into innerText: the screen-reader
// "Gemini said" label that prefixes every response, and a trailing block of
// action-button labels (copy / thumbs up / thumbs down / share & export …).
function stripGeminiChrome(text) {
  let t = text.replace(/^\s*Gemini said\s*/i, '');
  // Drop a trailing line that is only response-action button labels.
  t = t.replace(/\n[ \t]*(?:thumb_up|thumb_down|content_copy|share|more_vert|edit|Copy|Good response|Bad response|Share & export)[\s\S]*$/i, '');
  return t.trim();
}

export async function extractLatestResponse(page) {
  const responses = page.locator(SEL.response);
  const count = await responses.count();
  if (count === 0) return '(no response)';
  const last = responses.nth(count - 1);
  // Prefer the rendered message body so we never capture the "Gemini said"
  // screen-reader label or the action-button row. Fall back to the whole
  // component (chrome-stripped) only if those nodes aren't found.
  for (const sel of ['.markdown', 'message-content .markdown', 'message-content', '[class*="markdown"]']) {
    const node = last.locator(sel).first();
    if ((await node.count()) > 0) {
      const t = (await node.innerText()).trim();
      if (t) return stripGeminiChrome(t);
    }
  }
  return stripGeminiChrome((await last.innerText()).trim());
}

export async function sendPromptWithScreenshot(page, text, screenshotBuffer) {
  const tmpPath = pathJoin(tmpdir(), `gemini_ss_${Date.now()}.png`);
  await writeFile(tmpPath, screenshotBuffer);

  let attached = false;
  try {
    // Gemini usually has a hidden file input we can set directly
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(tmpPath);
      attached = true;
    } else {
      // Fall back: click the upload button and intercept the file chooser
      const uploadBtn = page
        .locator(
          'button[aria-label*="pload"], button[aria-label*="ttach"], button[aria-label*="mage"]',
        )
        .first();
      if (await uploadBtn.count() > 0) {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 3000 }),
          uploadBtn.click(),
        ]);
        await chooser.setFiles(tmpPath);
        attached = true;
      }
    }
    if (attached) await page.waitForTimeout(1500);
  } catch {
    attached = false;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }

  // Type and send the text (reuse existing sendPrompt logic)
  const input = page.locator(SEL.input);
  await input.click();
  await page.keyboard.press('Control+a');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Shift+Enter');
    if (lines[i]) await page.keyboard.type(lines[i]);
  }
  await page.keyboard.press('Enter');
  return attached;
}

export async function runGeminiConversation(page) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nGemini ready. Type a message and press Enter. Type "exit" to quit.\n');

  try {
    for (;;) {
      const userInput = await rl.question('You: ');
      const trimmed = userInput.trim();

      if (trimmed.toLowerCase() === 'exit') break;
      if (!trimmed) continue;

      await sendPrompt(page, trimmed);
      await waitForResponseComplete(page);
      const response = await extractLatestResponse(page);
      console.log(`\nGemini: ${response}\n`);
    }
  } finally {
    rl.close();
    console.log('Conversation ended.');
  }
}

export async function run() {
  const CDP_ENDPOINT = 'http://127.0.0.1:9222';

  if (await isCdpEndpointAvailable()) {
    console.log(`Existing CDP endpoint at ${CDP_ENDPOINT}. Attaching without launching Chrome.`);
    const { browser } = await attachToEdge();
    const context = getAttachedBrowserContext(browser);
    const page = await context.newPage();
    console.log('Navigating to Gemini...');
    await navigateToGemini(page);
    await runGeminiConversation(page);
    return;
  }

  const chromeConfig = BROWSER_CONFIGS.chrome;
  const localStatePath = chromeConfig.getLocalStatePath();
  const profiles = await discoverEdgeProfiles(localStatePath);

  if (profiles.length === 0) {
    throw new Error(`No Chrome profiles found in ${localStatePath}.`);
  }

  console.log('Available Google Chrome profiles:');
  profiles.forEach((profile, index) => {
    console.log(`${index + 1}. ${formatProfileLabel(profile)}`);
  });

  const selectedProfile = await selectProfile(profiles);
  const executablePath = getExecutablePath(chromeConfig.executablePaths);
  console.log(`Launching Chrome with profile: ${selectedProfile.directory}`);
  launchBrowserWithProfile(executablePath, selectedProfile.directory);

  if (!(await waitForCdpEndpoint())) {
    throw new Error(
      `Chrome launched but ${CDP_ENDPOINT} did not become available. Close Chrome fully and run again.`,
    );
  }

  const { browser } = await attachToEdge();
  const context = getAttachedBrowserContext(browser);
  const page = await context.newPage();
  console.log('Navigating to Gemini...');
  await navigateToGemini(page);
  await runGeminiConversation(page);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
