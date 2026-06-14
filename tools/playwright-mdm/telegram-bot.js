// telegram-bot.js — Telegram INBOUND. Chat with Jarvis from your phone.
//
// Long-polls the Telegram Bot API (getUpdates) and answers each message through
// the engine (Gemini by default), replying via sendMessage. Opt-in: it only
// runs while you turn it on, and while the Hub is open.
//
// Note: each inbound message drives the engine — with the Gemini engine that
// means the browser is driven on your behalf. Keep it single-user/supervised.

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _state = { running: false, token: null, offset: 0, replyFn: null, lastError: null };

export function telegramStatus() {
  return { running: _state.running, lastError: _state.lastError };
}

async function tg(method, params, { timeoutMs = 35000 } = {}) {
  const res = await fetch(API(_state.token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

async function loop() {
  while (_state.running) {
    try {
      const res = await tg('getUpdates', { offset: _state.offset, timeout: 30 });
      if (!res.ok) { _state.lastError = res.description || 'getUpdates failed'; await sleep(3000); continue; }
      _state.lastError = null;
      for (const u of res.result) {
        _state.offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text) continue;
        let reply;
        try { reply = await _state.replyFn(msg.text); }
        catch (e) { reply = `⚠ ${e.message}`; }
        await tg('sendMessage', { chat_id: msg.chat.id, text: String(reply).slice(0, 4000) }).catch(() => {});
      }
    } catch (e) {
      _state.lastError = e.message;
      await sleep(3000); // network hiccup / timeout — back off, then retry
    }
  }
}

/** Start listening. replyFn(text) -> string answer. */
export async function startTelegram(token, { replyFn }) {
  if (_state.running) return telegramStatus();
  if (!token) throw new Error('no telegram token');
  _state.token = token;
  _state.replyFn = replyFn;
  _state.running = true;
  _state.lastError = null;
  loop(); // fire-and-forget; guarded by _state.running
  return telegramStatus();
}

export function stopTelegram() {
  _state.running = false;
  return telegramStatus();
}
