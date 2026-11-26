# WhatsApp Protection

WhatsApp Protection is a persistent Node.js service with an Express website, Baileys WhatsApp connection, SQLite database and command-based security controls. Deploy it as a continuously running Render Web Service with a persistent disk. It is not a reliable Vercel serverless bot.

## Implemented components

- Existing responsive website and policy/documentation pages.
- Owner bootstrap `/pair` page with real Baileys pairing-code generation, short-lived pairing-status token, polling and copy button. Additional users use the `/pair` WhatsApp command.
- `/dashboard` public read-only service status page; protection settings are managed by the configured owner and successfully paired numbers through WhatsApp commands.
- SQLite storage for linked numbers, protection settings, pairing history, activity logs and security events.
- Baileys multi-file authentication under `DATA_DIR/auth` for the primary owner and `DATA_DIR/auth/linked/<phone>` for each additional linked account.
- WhatsApp commands: `/pair`, `/menu`, `/developers`, `/status`, `/activate <feature>` and `/deactivate <feature>` where `<feature>` is `ban_protection`, `bug_protection` or `soam_protection`. Settings are stored per phone number in SQLite. The owner sends commands from the bot account's own "Message yourself" chat; linked users send them to the bot in a private chat.
- Native-flow menu with image header, quick replies and a WhatsApp Channel URL button. Native message rendering depends on WhatsApp client compatibility and must be verified with a linked account.
- Developer contact buttons for Lord Voyage and Calvin The Great.

## Protection behavior

### Ban Protection
When enabled, bot-generated replies are serialized per recipient, spaced by at least 1.8 seconds, limited to eight sends per recipient per minute and capped at 20 queued sends. It is a conservative outbound automation throttle, not a ban-prevention guarantee. It does not control messages sent manually from the linked phone or by other services.

### Bug Protection
When enabled, runtime errors and connection failures are recorded as security events. The Baileys reconnect loop uses exponential backoff with jitter and a bounded delay. Reconnect backoff is also used as a baseline reliability measure when the feature is disabled; activation adds detailed security-event capture and a longer bounded recovery window. This does not eliminate bugs or provider outages.

### SOAM Protection
SOAM means monitoring the bot against spam, suspicious activity, account abuse and malicious commands. When enabled, the bot monitors command attempts, records unauthorized command attempts, detects command bursts and repeated commands, and applies a temporary five-minute cooldown after eight command attempts in 60 seconds or five repetitions of the same command in that window. SOAM also records high-volume inbound bursts (40 messages per sender per minute) and repeated identical text patterns (15 repeats per minute), using a short hash rather than storing the message body. Command authorization is always enforced, even when SOAM is disabled: only the configured owner and numbers with active linked-device records may use protected commands. This cannot inspect WhatsApp's private enforcement systems, all linked-device actions or the user's phone.

## Local installation

Requirements: Node.js 20.19 or newer (22 LTS recommended, same as the Docker image), npm, and a WhatsApp account you own or are authorized to link.

1. Copy `.env.example` to `.env`.
2. Optionally set `OWNER_NUMBER` (international digits only) to reserve the primary bot account for that number. If it is unset, the first number paired on the website becomes the primary bot account and owner. Every other number submitted on the website (or sending `/pair` to the bot privately) gets its own independent linked-device session.
3. Run `npm ci`.
4. Run `npm run check` (syntax) and `npm test` (server, database, pairing-authorization and command tests).
5. Run `npm start` and open `http://localhost:3000`.

All environment variables are documented in `.env.example`. None are required; there is no admin token or activation key.

SQLite is created at `DATA_DIR/whatsapp-protection.sqlite`; Baileys credentials are stored at `DATA_DIR/auth`. Never publish or commit this directory.

## Render deployment

1. Push the project to a private Git repository.
2. Create a Render Blueprint using `render.yaml`, or create a Docker Web Service.
3. Keep the persistent disk mounted at `/data` (the blueprint provisions a 1 GB disk; Render disks need a paid instance type such as Starter). Render sets `PORT` itself; the server listens on it.
4. Set `DATA_DIR=/data` in the Render environment, and optionally `OWNER_NUMBER` (recommended, so nobody else can claim the primary bot account before you pair it).
5. Deploy and wait for `/api/health` to report `ok: true`.
6. Open `/pair`, enter the configured owner number, and request the primary bot's pairing code. After the main bot is connected, each additional user sends `/pair` to the bot in a private chat.
7. On the phone, open WhatsApp → Linked devices → Link a device → Link with phone number, then enter the displayed code.
8. Send `/menu` from the configured owner account or any successfully paired account.

Do not delete or replace the Render disk: it contains the Baileys session and SQLite database. Back it up securely. Treat `/data/auth` contents as secrets.

## API

Public endpoints:
- `GET /api/health` — service and database health indicator.
- `GET /api/status` — coarse WhatsApp connection state.
- `POST /api/pair-code` — body `{"phone":"<digits>"}`. Pairs the primary bot account (OWNER_NUMBER, or the first number when it is unset); any other number gets its own linked-device session. Returns a genuine Baileys code and a short-lived `pairingToken`.
- `GET /api/pair-code/status?token=...` — returns the code and status (`pairing`, `connecting`, `connected`, `pairing_expired`) for that one pairing request.

The dashboard is read-only. There are no public administrator endpoints. Protection changes are performed through WhatsApp commands by the configured owner or an active paired number.

## Limitations and safety

- Pairing codes from `/pair` expire after 10 minutes; unfinished pairing sessions and their temporary auth files are removed automatically.
- `MAX_LINKED_ACCOUNTS` (default 100, `0` = unlimited) only exists because every linked account is a separate live WhatsApp connection using server memory; raise it to match your instance size.
- Pairing and real WhatsApp messaging require a live compatible WhatsApp account and network access; these cannot be fully tested without linking an account.
- Native-flow button appearance and callbacks must be tested with the deployed Baileys version and current WhatsApp clients.
- The bot does not scan the phone or uploaded files, detect all account compromise, reverse bans, or guarantee immunity from WhatsApp enforcement.
- Only pair accounts you own or are authorized to administer. Do not use the bot for unsolicited bulk messaging, spam, harassment or platform-limit evasion.
- WhatsApp Protection is an independent project and is not affiliated with WhatsApp or Meta. Each connected primary or additional account sends one WhatsApp Channel follow request after connection. Success is stored only after WhatsApp accepts the request (so it is not repeated); a failed request is logged and retried on the next connection.

## Verification

Run `npm run check` for JavaScript syntax checks and `npm test` for the automated suite (uses a temporary `DATA_DIR` and fake sockets; it never contacts WhatsApp). A live pairing, outbound messaging and interactive-button test requires dependency installation, deployment and an authorized WhatsApp account.

### Dashboard access
The dashboard is intentionally read-only and does not require an administrator token. It shows only basic service health. Protection controls, security-event logs, and WhatsApp session files are not exposed publicly. Enable protections using WhatsApp commands from the configured owner or an active paired account.
