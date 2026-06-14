// linkedin.js — Compose a LinkedIn post in your already signed-in Edge.
//
// Jarvis takes the post text (from your marketing plan) + photo references and
// drives the LinkedIn composer: open "Start a post", write the text, attach the
// images — then STOPS at the Post button. The final submit is always yours.
//
// It runs inside the attached Edge context (the same signed-in session Jarvis
// uses for Gemini), so you're already authenticated. After every step it
// captures a JPEG frame and hands it to onStep() so the Hub can show a live
// screen of what it's doing.

import { getEdgeContext } from './jarvis-bridge.js';
import { resolveElement } from './heal.js';

const LINKEDIN_FEED = 'https://www.linkedin.com/feed/';

// Resilient selector lists — LinkedIn's DOM shifts, and the e2e mock mirrors
// the real class/role names, so the same code works against both.
const SEL = {
  startPost: [
    'button.share-box-feed-entry__trigger',
    'button:has-text("Start a post")',
    '[aria-label*="Start a post" i]',
    'button:has-text("Create a post")',
  ],
  editor: [
    'div.ql-editor[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    '[data-placeholder][contenteditable="true"]',
    'div[contenteditable="true"]',
  ],
  photoButton: [
    'button[aria-label*="photo" i]',
    'button[aria-label*="media" i]',
    'button:has-text("Photo")',
  ],
  doneButton: [
    'button:has-text("Done")',
    'button:has-text("Next")',
    'button[aria-label="Done"]',
  ],
  postButton: [
    'button.share-actions__primary-action',
    'button:has-text("Post"):not([aria-label*="photo" i])',
    '[aria-label="Post"]',
  ],
};

async function clickFirst(page, selectors, { timeout = 8000 } = {}) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) && (await loc.isVisible())) { await loc.click({ timeout }); return sel; }
    } catch { /* try next */ }
  }
  throw new Error('none clickable: ' + selectors.join(' | '));
}

/**
 * Fill the LinkedIn composer and stop before posting.
 * @returns {ok, ready, posted:false, postButtonFound, imageCount, typedText}
 */
export async function composeLinkedInPost({
  text = '', images = [], url = LINKEDIN_FEED, keepOpen = true, onStep = () => {},
} = {}) {
  const ctx = await getEdgeContext();
  const page = await ctx.newPage();
  const shot = async (label, extra = {}) => {
    let image = null;
    try { image = (await page.screenshot({ type: 'jpeg', quality: 50 })).toString('base64'); } catch { /* ignore */ }
    onStep({ label, image, ...extra });
  };

  try {
    onStep({ label: `Opening ${url}` });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    await shot('Page loaded');

    onStep({ label: 'Opening the post composer…' });
    const trigger = await resolveElement(page, {
      intent: 'open the "Start a post" composer',
      staticSelectors: SEL.startPost,
      keywords: ['start a post', 'start', 'create a post', 'create', 'post'],
      onStep,
    });
    await trigger.locator.click({ timeout: 8000 });

    const editorRes = await resolveElement(page, {
      intent: 'the post text editor box',
      staticSelectors: SEL.editor,
      keywords: ['what do you want to talk about', 'talk', 'write', 'editor', 'text', 'post'],
      requireEditable: true,
      onStep,
    });
    const editor = editorRes.locator;
    await editor.click();
    await shot('Composer open');

    onStep({ label: 'Writing the post…' });
    await page.keyboard.insertText(text);
    await shot('Text entered');

    let imageCount = 0;
    if (images.length) {
      onStep({ label: `Attaching ${images.length} image(s)…` });
      let fileInput = page.locator('input[type="file"]').first();
      if (!(await fileInput.count())) {
        await clickFirst(page, SEL.photoButton).catch(() => {});
        fileInput = page.locator('input[type="file"]').first();
      }
      if (await fileInput.count()) {
        await fileInput.setInputFiles(images);
        await page.waitForTimeout(1500);
        imageCount = await fileInput.evaluate((el) => el.files?.length || 0).catch(() => images.length);
        // Some flows show an editor overlay with Next/Done to return to the post.
        await clickFirst(page, SEL.doneButton, { timeout: 3000 }).catch(() => {});
        await shot('Images attached');
      } else {
        onStep({ label: '⚠ No file input found — skipped image attach.' });
      }
    }

    // Locate the Post button (self-healing) — but DO NOT click it.
    let postButtonFound = false;
    try {
      await resolveElement(page, {
        intent: 'the Post (submit) button',
        staticSelectors: SEL.postButton,
        keywords: ['post', 'share', 'publish'],
        onStep, useGemini: false,
      });
      postButtonFound = true;
    } catch { postButtonFound = false; }
    const typedText = (await editor.innerText().catch(() => '')).trim();
    await shot('Ready — review and click Post yourself', { ready: true });

    if (!keepOpen) await page.close().catch(() => {});
    return { ok: true, ready: true, posted: false, postButtonFound, imageCount, typedText };
  } catch (e) {
    await shot('Error: ' + e.message);
    if (!keepOpen) await page.close().catch(() => {});
    return { ok: false, posted: false, error: e.message };
  }
}
