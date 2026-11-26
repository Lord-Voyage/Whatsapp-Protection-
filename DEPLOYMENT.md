# Render deployment

## Required service configuration

- Runtime: Docker Web Service
- Node.js: 22 LTS (inside Docker image)
- Persistent disk: mount at `/data`
- `DATA_DIR=/data`
- `PORT`: set automatically by Render (defaults to 3000 locally)
- `OWNER_NUMBER` (optional, recommended): bot owner's WhatsApp number, international digits only. If unset, the first number paired on the website becomes the primary bot account.
- `NODE_ENV=production`
- Optional: `LOG_LEVEL`, `BAILEYS_LOG_LEVEL`, `MAX_LINKED_ACCOUNTS`, `INTERACTIVE_BUTTONS`, `CHANNEL_JID`, `CHANNEL_NAME` (see `.env.example`)
- Instance type: a paid plan (e.g. Starter); persistent disks are not available on the free plan


## Deploy

1. Push the project to a private Git repository.
2. In Render, create a Blueprint and select the repository, or create a Docker Web Service.
3. Ensure the disk is mounted at `/data`. Do not use an ephemeral filesystem for Baileys credentials or SQLite.
4. Deploy. Render health checks use `GET /api/health`.
5. Visit `/pair`, submit the owner number first, and wait for the primary bot's device-linking code. Other users can then pair their own numbers on the same page. The copy button appears when the code is ready.
6. In WhatsApp, open Linked devices → Link a device → Link with phone number, and enter the code.
7. Additional users send `/pair` to the bot from their own private WhatsApp chats. Each receives a genuine device-linking code in that same chat; after linking, that number is authorized to use bot commands.

## Persistent data

- Baileys authentication: `/data/auth`
- SQLite database: `/data/whatsapp-protection.sqlite`

Back up the disk securely. Never publish, commit or share these files. Losing the disk may require pairing again.


## Vercel limitation

Do not deploy the Baileys process as a Vercel serverless function. The bot needs a persistent process and durable authentication storage. A separate static frontend may be hosted elsewhere, but the bot and its session data must remain on a persistent host such as Render.

## WhatsApp and protection limitations

- Ban Protection rate-limits only bot-generated outbound replies; it cannot guarantee that WhatsApp will not restrict an account.
- Bug Protection logs runtime/connection failures and improves reconnect recovery; it cannot eliminate defects or upstream outages.
- SOAM monitors bot command abuse and suspicious command patterns; it cannot inspect WhatsApp's private internal enforcement systems or secure the phone itself.
- Real Baileys pairing and native-flow message rendering require an authorized live WhatsApp account for end-to-end verification.

## Dashboard and administration

`/dashboard` is a public, read-only service status page. It does not expose activity logs, protection toggles, session controls, or private owner information. The configured owner and successfully paired users manage their own protections by sending `/activate <feature>`, `/deactivate <feature>` and `/status` (features: `ban_protection`, `bug_protection`, `soam_protection`). The owner uses the bot account's "Message yourself" chat; linked users message the bot privately. No `ADMIN_TOKEN` is required.

To replace an already registered WhatsApp session, stop the service, remove the contents of `DATA_DIR/auth` from the persistent disk using the host's private shell/file tools, then restart and pair again. Never expose or share the auth directory. Linked accounts live in `DATA_DIR/auth/linked/<phone>`; keep that folder if you only want to re-pair the primary account.
