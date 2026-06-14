// heal.js — self-healing element resolution.
//
// Web apps like LinkedIn rename classes and reshuffle their DOM constantly, so
// a fixed selector breaks silently. This resolver lets the engine correct
// itself in three tiers:
//
//   1. STATIC    — try the known selectors (fast, zero cost).
//   2. DOM       — enumerate the visible interactive elements and pick the best
//                  match for the intent by text / aria / placeholder (no LLM).
//   3. VISION    — capture a SCREENSHOT of the page + the element list and ask
//                  Gemini to point at the right element. The engine literally
//                  sees the screen and decides.
//
// Each successful correction is reported through onStep so the live screen shows
// "🔧 Self-corrected …".

// Tag every visible, interactive element with data-jarvis-cand="i" and return a
// compact description list — this is the textual "DOM snapshot" we reason over.
async function enumerateCandidates(page) {
  return page.evaluate(() => {
    const sel = 'button, a[href], [role="button"], [contenteditable="true"], input, textarea, [role="textbox"]';
    const out = [];
    let i = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width <= 1 || r.height <= 1 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      el.setAttribute('data-jarvis-cand', String(i));
      out.push({
        i,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        aria: (el.getAttribute('aria-label') || '').slice(0, 80),
        placeholder: (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').slice(0, 80),
        text: ((el.innerText || el.value || '').trim().replace(/\s+/g, ' ')).slice(0, 80),
        editable: el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.getAttribute('role') === 'textbox',
      });
      i++;
    }
    return out;
  });
}

function scoreCandidate(c, keywords, requireEditable) {
  const hay = `${c.text} ${c.aria} ${c.placeholder} ${c.role}`.toLowerCase();
  let score = 0;
  for (const k of keywords) if (k && hay.includes(k.toLowerCase())) score += 2;
  if (requireEditable && c.editable) score += 1;
  if (requireEditable && !c.editable) score -= 3; // never type into a button
  return score;
}

/**
 * Resolve a Playwright locator for `intent`, healing if the static selectors miss.
 * @returns {{ locator, how:'selector'|'dom'|'vision' }}
 */
export async function resolveElement(page, {
  intent, staticSelectors = [], keywords = [], requireEditable = false,
  onStep = () => {}, useGemini = true, useHeuristic = true, geminiAsk = null,
} = {}) {
  // 1 · STATIC
  for (const sel of staticSelectors) {
    const loc = page.locator(sel).first();
    try { if ((await loc.count()) && (await loc.isVisible())) return { locator: loc, how: 'selector' }; } catch { /* next */ }
  }

  // Capture the DOM snapshot (this also screenshots for the vision tier).
  const candidates = await enumerateCandidates(page);

  // 2 · DOM HEURISTIC
  const scored = candidates
    .map((c) => ({ c, score: scoreCandidate(c, keywords, requireEditable) }))
    .sort((a, b) => b.score - a.score);
  if (useHeuristic && scored.length && scored[0].score > 0) {
    const c = scored[0].c;
    onStep({ label: `🔧 Self-corrected (DOM): "${c.text || c.aria || c.placeholder || c.tag}" → ${intent}` });
    return { locator: page.locator(`[data-jarvis-cand="${c.i}"]`).first(), how: 'dom' };
  }

  // 3 · VISION — show Gemini the screenshot + element list, let it choose.
  if (useGemini) {
    let shot = null;
    try { shot = await page.screenshot({ type: 'jpeg', quality: 60 }); } catch { /* ignore */ }
    const list = candidates
      .map((c) => `${c.i}: [${c.tag}${c.role ? '/' + c.role : ''}] text="${c.text}" aria="${c.aria}" placeholder="${c.placeholder}"`)
      .join('\n');
    const prompt =
      `You are guiding a browser automation. Goal: ${intent}.\n` +
      `The attached screenshot shows the current page. The visible interactive elements are:\n${list}\n\n` +
      `Reply with ONLY the number of the element that best achieves the goal, or -1 if none fit.`;
    onStep({ label: `👁️ Self-correcting via vision: asking Gemini to locate "${intent}"…` });
    let reply = '';
    try {
      reply = geminiAsk
        ? await geminiAsk(prompt, shot)
        : await (await import('./jarvis-bridge.js')).askGeminiVision(prompt, shot);
    } catch (e) { throw new Error(`vision self-heal failed: ${e.message}`); }
    const m = String(reply).match(/-?\d+/);
    const idx = m ? Number(m[0]) : -1;
    if (idx >= 0 && candidates.some((c) => c.i === idx)) {
      onStep({ label: `🔧 Self-corrected (vision): Gemini chose element #${idx}` });
      return { locator: page.locator(`[data-jarvis-cand="${idx}"]`).first(), how: 'vision' };
    }
  }

  throw new Error(`Could not resolve element for: ${intent}`);
}
