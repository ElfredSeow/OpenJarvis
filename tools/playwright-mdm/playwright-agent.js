import { chromium } from 'playwright';

let browser = null;
let page = null;

async function getPage() {
  if (!browser) {
    browser = await chromium.launch({ headless: false, slowMo: 50 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
  }
  return page;
}

export async function executeCommand(command) {
  const p = await getPage();

  try {
    switch (command.action) {
      case 'navigate': {
        await p.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await p.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await p.bringToFront();
        return { type: 'navigate', url: p.url(), title: await p.title() };
      }

      case 'screenshot': {
        const buffer = await p.screenshot({ fullPage: command.fullPage ?? false });
        return { type: 'screenshot', screenshot: buffer.toString('base64'), url: p.url() };
      }

      case 'click': {
        if (command.text) {
          await p.getByText(command.text, { exact: false }).first().click({ timeout: 10000 });
        } else if (command.selector) {
          await p.locator(command.selector).first().click({ timeout: 10000 });
        } else {
          return { type: 'error', error: 'click requires "text" or "selector"' };
        }
        return { type: 'click', message: `Clicked "${command.text ?? command.selector}"` };
      }

      case 'type': {
        if (!command.selector) return { type: 'error', error: 'type requires "selector"' };
        const field = p.locator(command.selector).first();
        await field.click({ timeout: 10000 });
        await p.keyboard.press('Control+a');
        await p.keyboard.type(command.text ?? '', { delay: 30 });
        return { type: 'type', message: `Typed into ${command.selector}` };
      }

      case 'extract': {
        const sel = command.selector ?? 'body';
        const text = await p.locator(sel).first().innerText({ timeout: 10000 });
        return { type: 'extract', text: text.trim().slice(0, 4000) };
      }

      case 'scroll': {
        const amount = command.amount ?? 600;
        const delta = command.direction === 'up' ? -amount : amount;
        await p.evaluate((y) => window.scrollBy(0, y), delta);
        return { type: 'scroll', message: `Scrolled ${command.direction ?? 'down'} ${amount}px` };
      }

      case 'press': {
        if (!command.key) return { type: 'error', error: 'press requires "key"' };
        await p.keyboard.press(command.key);
        return { type: 'press', message: `Pressed ${command.key}` };
      }

      case 'wait': {
        if (command.selector) {
          await p.waitForSelector(command.selector, { timeout: command.timeout ?? 15000 });
          return { type: 'wait', message: `Element "${command.selector}" appeared` };
        }
        const ms = command.ms ?? 1000;
        await p.waitForTimeout(ms);
        return { type: 'wait', message: `Waited ${ms}ms` };
      }

      case 'url': {
        return { type: 'url', url: p.url() };
      }

      case 'title': {
        return { type: 'title', title: await p.title() };
      }

      default:
        return { type: 'error', error: `Unknown action: "${command.action}"` };
    }
  } catch (err) {
    return { type: 'error', error: err.message };
  }
}

/** Screenshot the agent's current page for the live-view stream. */
export async function agentScreenshot(opts = { type: 'jpeg', quality: 50 }) {
  const p = await getPage();
  return p.screenshot(opts);
}

export async function closeAutomationBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}
