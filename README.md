# Contact AI Agent

A self-hosted AI assistant that answers your customers on **WhatsApp, Telegram, Email, Facebook Messenger and Instagram** from one shared inbox. It learns from your own documents and web pages, replies in **Arabic or English** (whatever the customer writes in), and sends customers to the right link or phone number when needed.

Everything runs on your own computer with free, local AI ([Ollama](https://ollama.com)). No paid APIs.

## What's inside

| Part | What it does |
| --- | --- |
| **Shared inbox** | All conversations from every channel in one place, live. Read, reply yourself, or let the AI answer. Turn the AI off per chat to take over. |
| **Knowledge base** | Upload PDF / Word / text files, add web pages, or type notes. The AI answers only from this. A "Try it" box lets you test answers. |
| **Redirects** | Rules like "when the customer wants to buy → send +971…" or "→ send https://…". |
| **Channels** | WhatsApp (QR scan, like WhatsApp Web), Telegram bot, any number of email accounts (Gmail or your domain, IMAP/SMTP), Facebook + Instagram (official Meta API). |
| **Settings** | Company name, AI personality, fallback message, reply delay, model choice, admin password. |

Stack: Node.js (Express, Socket.IO), React (Vite), SQLite, Ollama. One Docker Compose file runs it all.

## Quick start (Docker, recommended)

Requirements: [Docker Desktop](https://www.docker.com/products/docker-desktop/). For fast answers, a laptop with 16 GB+ RAM (an NVIDIA GPU helps a lot, see the comment in `docker-compose.yml`).

```bash
git clone https://github.com/shamoos63/contact-ai-agent.git
cd contact-ai-agent
cp .env.example .env        # then set ADMIN_PASSWORD
docker compose up -d --build
```

Open **http://localhost:3000** and log in with the username/password from `.env`.

On the first start the app downloads the AI models (`qwen2.5:7b` ≈ 4.7 GB and `bge-m3` ≈ 1.2 GB). You can watch progress under **Settings → AI engine**; AI replies start working when both show "Installed".

> On a Mac, Ollama inside Docker cannot use the Apple GPU. For much faster replies install the Ollama app on the Mac itself, remove the `ollama` service from `docker-compose.yml`, and set `OLLAMA_URL=http://host.docker.internal:11434` in `.env`.

## Running without Docker

Requirements: Node.js 20+ and [Ollama](https://ollama.com/download).

```bash
ollama pull qwen2.5:7b && ollama pull bge-m3
npm run install:all
npm run build
cp .env.example .env && export $(grep -v '^#' .env | xargs)
npm start                  # http://localhost:3000
```

For development, run `npm run dev:server` and `npm run dev:client` (dashboard on http://localhost:5173). Tests: `npm test`.

## First-time setup in the dashboard

1. **Settings** – set your company name and adjust the assistant's instructions and fallback message.
2. **Knowledge** – upload your company documents and add your website pages. Use **Try it** to check the answers in Arabic and English.
3. **Redirects** – add where to send people (sales WhatsApp link, support phone, booking page…).
4. **Channels** – connect each channel (below).

## Connecting channels

### WhatsApp
Channels → WhatsApp → tick **Enabled** → scan the QR with the phone (WhatsApp → Settings → Linked devices → Link a device).
This uses WhatsApp Web (via [Baileys](https://github.com/WhiskeySockets/Baileys)), which is not an official API: use a **separate number**, since WhatsApp may ban numbers that look automated. The session is saved in `data/whatsapp-auth`, so you scan only once. Group chats are ignored.

### Telegram
Message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token, paste it under Channels → Telegram and click **Save & connect**. Customers message your bot.

### Email (Gmail and your own domain)
Channels → Email → **Add account**.
- **Gmail**: turn on 2-step verification, create an [app password](https://myaccount.google.com/apppasswords), click **Use Gmail settings**, and use the app password.
- **Custom domain**: use the IMAP/SMTP servers from your host (usually `mail.yourdomain.com`, IMAP 993 SSL, SMTP 465 SSL or 587 with SSL off).

Click **Test connection**, then **Save**. Only emails that arrive after the account is added get answered; newsletters, no-reply senders and auto-replies are skipped. Replies go out in the same thread.

### Facebook Messenger & Instagram (when you have the API access)
The integration is built and waits for your credentials:
1. Create an app at [developers.facebook.com](https://developers.facebook.com) and add the **Messenger** product (and **Instagram** for Instagram Direct). Your Instagram must be a Business/Creator account linked to your Facebook Page.
2. Generate a **Page access token** for your Page; note the **Page ID** and the app's **App secret** (App settings → Basic).
3. Give this server a public HTTPS address. The simplest free option: `docker compose --profile tunnel up -d`, then `docker compose logs tunnel` shows a `https://….trycloudflare.com` address. (That free quick-tunnel address changes on each restart; for a fixed one create a named Cloudflare Tunnel.)
4. In Meta → Messenger/Instagram → Webhooks, set the callback URL to `https://<your-address>/webhooks/meta`, choose any **verify token**, and subscribe to `messages`.
5. In the dashboard: Channels → Facebook & Instagram, fill in Page ID, Page token, App secret and the same verify token, tick the channels, **Save**.

Until your Meta app passes App Review, only people with a role on the app can message it.

## How the AI answers

1. A message arrives on any channel and appears in the inbox.
2. After a short wait (to group quick messages), the agent finds the most relevant parts of the knowledge base.
3. The local model writes a reply in the customer's language, using only that knowledge and your redirect rules. If it doesn't know, it sends your fallback message.
4. The reply is sent on the same channel and shown in the inbox. Turn off **AI auto-reply** on a conversation to answer it yourself, or use **🤖 AI reply** to ask the AI for one answer.

## Data & security

- Everything is stored locally in `./data` (SQLite database, WhatsApp session). Back up this folder.
- Passwords and tokens are stored in that database on your machine. Keep the computer and the `data` folder private.
- Change the admin password after the first login (Settings). Don't expose port 3000 to the internet directly; only `/webhooks/meta` needs to be public, through the tunnel.
