# Open Jarvis — Playwright MDM Browser module (Powered-By-Webapp-LLM)

Drives Microsoft Edge through your **managed (MDM) browser profile** via CDP, and
uses the **Gemini web app** — running inside that already signed-in profile — as
the reasoning brain. No Gemini API key: **your Gemini Webapp license** does the
thinking, Open Jarvis orchestrates and stores the output.

Sources combined:
- `raid-ppcoe/Playwright-Module-for-MDM-Browsers` — runner shell
- `ElfredSeow/Playwright-for-MDM-Browser @ Powered-By-Webapp-LLM` — Gemini webapp engine

## Files

| File | Role |
|------|------|
| `attach.js` | Edge profile discovery, CDP attach (`127.0.0.1:9222`), smoke-test report |
| `gemini.js` | Drives `gemini.google.com` (send prompt, wait, extract response) |
| `playwright-agent.js` | Executes JSON command blocks (`navigate/click/type/extract/...`) |
| `gemini-server.js` | Local chat-agent UI on port 3000 |
| **`jarvis-bridge.js`** | **The API Open Jarvis core calls** — `askGemini`, `research`, `act` |
| `reports/gemini-sessions/` | Audit trail of prompts + responses |

## Setup

```bash
cd tools/playwright-mdm
npm install
npx playwright install
# Close Edge first, then pick your MDM profile + attach:
npm start
```

Once attached (CDP live on `127.0.0.1:9222`), Open Jarvis can call the bridge.

## Bridge API

```js
import { askGemini, research, act, dispose } from './jarvis-bridge.js';

// REASON — produce content with your Gemini license
const summary = await askGemini('Summarise this repo for a LinkedIn launch post: ...');

// RESEARCH — look at a live page on a SEPARATE tab, analyse with Gemini
const findings = await research(
  'https://www.linkedin.com/in/some-profile/recent-activity/',
  'Classify recent post types and infer their objectives',
);

// ACT — let Gemini plan browser commands and run them
const { plan, results } = await act('Open the product page and extract the headline');

await dispose(); // on shutdown (leaves Edge running)
```

## Dedicated Gemini tab (no navigation clobbering)

`jarvis-bridge.js` keeps **one dedicated Gemini tab** alive across calls and never
navigates it away from `gemini.google.com`, so the conversation/context is
preserved. `research()` opens a **separate page** for the target URL, extracts its
text, closes it, and hands the text to the Gemini tab for analysis — the two never
collide.

## Notes & guardrails

- Sign-in stays manual/profile-based; the module never automates Microsoft/Google login.
- Selectors target Gemini's live DOM and can change — they live in `SEL` in `gemini.js`.
- Keep this single-user and human-supervised; respect Google ToS and your org's MDM policy.
- Approval gate stays in Open Jarvis core — nothing here auto-publishes.
