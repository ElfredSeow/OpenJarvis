// channels.js — Phase 4. Outbound notification channels: Discord / Slack
// incoming webhooks and Telegram bot messages. Pure HTTP, no Python core
// needed — so digests and monitor alerts reach you wherever you are.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE = join(__dirname, 'channels.json');

async function load() {
  if (!existsSync(STORE)) return { channels: [] };
  try { return JSON.parse(await readFile(STORE, 'utf8')); } catch { return { channels: [] }; }
}
async function save(d) { await writeFile(STORE, JSON.stringify(d, null, 2), 'utf8'); return d; }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Don't leak secrets to the UI — mask tokens/URLs.
function redact(c) {
  const m = { ...c };
  if (m.webhookUrl) m.webhookUrl = m.webhookUrl.slice(0, 30) + '…';
  if (m.botToken) m.botToken = m.botToken.slice(0, 6) + '…';
  return m;
}

export async function listChannels() { return (await load()).channels.map(redact); }

export async function createChannel({ name, kind, webhookUrl = '', botToken = '', chatId = '' }) {
  if (!['discord', 'slack', 'telegram'].includes(kind)) throw new Error('kind must be discord|slack|telegram');
  const d = await load();
  const c = { id: uid(), name: (name || kind).trim(), kind, webhookUrl, botToken, chatId, enabled: true };
  d.channels.push(c); await save(d); return redact(c);
}
export async function deleteChannel(id) {
  const d = await load(); d.channels = d.channels.filter((x) => x.id !== id); await save(d);
}
export async function toggleChannel(id, enabled) {
  const d = await load(); const c = d.channels.find((x) => x.id === id);
  if (!c) throw new Error('channel not found'); c.enabled = !!enabled; await save(d); return redact(c);
}

async function deliver(c, text) {
  try {
    if (c.kind === 'discord') {
      const r = await fetch(c.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) });
      return { ok: r.ok, status: r.status };
    }
    if (c.kind === 'slack') {
      const r = await fetch(c.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      return { ok: r.ok, status: r.status };
    }
    if (c.kind === 'telegram') {
      const url = `https://api.telegram.org/bot${c.botToken}/sendMessage`;
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c.chatId, text: text.slice(0, 4000) }) });
      return { ok: r.ok, status: r.status };
    }
    return { ok: false, error: 'unknown kind' };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Send to one channel by id (test button). */
export async function testChannel(id, text = 'Open Jarvis test message ✅') {
  const d = await load(); const c = d.channels.find((x) => x.id === id);
  if (!c) throw new Error('channel not found');
  return deliver(c, text);
}

/** Raw bot token of the first enabled Telegram channel (for inbound listening). */
export async function telegramToken() {
  const d = await load();
  const c = d.channels.find((x) => x.kind === 'telegram' && x.enabled && x.botToken);
  return c?.botToken || null;
}

/** Fan out to every enabled channel. Used by digests/monitors via notifyFn. */
export async function sendAll(text) {
  const d = await load();
  const results = [];
  for (const c of d.channels) if (c.enabled) results.push({ id: c.id, ...(await deliver(c, text)) });
  return results;
}
