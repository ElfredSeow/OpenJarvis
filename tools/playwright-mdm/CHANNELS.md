# Channels setup — get alerts & chat with Jarvis

All outbound. Configure in the Hub → **Channels** module. Secrets are stored
locally in `channels.json` (git-ignored) and redacted in the UI.

## Discord (webhook)
1. In your Discord server: **Server Settings → Integrations → Webhooks → New Webhook**.
2. Pick a channel, **Copy Webhook URL**.
3. Hub → Channels → kind **Discord**, paste the URL into *Webhook URL*, **Add**.
4. Click **Test** — a message should appear in the Discord channel.

## Slack (incoming webhook)
1. Create a Slack app at <https://api.slack.com/apps> → **Incoming Webhooks** → enable.
2. **Add New Webhook to Workspace**, pick a channel, copy the URL.
3. Hub → Channels → kind **Slack**, paste into *Webhook URL*, **Add**, then **Test**.

## Telegram (bot)
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the **bot token**.
2. Get your **chat id**: message your new bot once, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `message.chat.id` (or message **@userinfobot**).
3. Hub → Channels → kind **Telegram**, paste **token** + **chat id**, **Add**, **Test**.

### Chat with Jarvis from your phone (inbound)
Once a Telegram channel is added and enabled, flip **📱 Listen** at the bottom of
the Channels module. Now any message you send your bot is answered through the
engine (Gemini) and replied back to you. Turn **Listen** off to stop.

> Inbound replies drive the Gemini browser per message — keep it single-user and
> supervised, and remember it only runs while the Hub is open.

## Where alerts come from
- **Monitors** → each run can notify enabled channels.
- **Morning Digest** → the compiled brief is pushed to all enabled channels.
