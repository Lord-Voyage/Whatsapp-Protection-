# WhatsApp Protection

WhatsApp Protection is a persistent Node.js service with an Express website, Baileys WhatsApp connection, SQLite database and command-based security controls. Deploy it as a continuously running Render Web Service with a persistent disk. It is not a reliable Vercel serverless bot.

## Implemented components

- Existing responsive website and policy/documentation pages.
- Independent `/pair` page with real Baileys pairing-code generation, short-lived pairing-status token, polling and copy button.
- `/dashboard` public read-only service status page; protection settings remain owner-only through WhatsApp commands.
- SQLite storage for linked numbers, protection settings, pairing history, activity logs and security events.
- Baileys multi-file authentication under `DATA_DIR/auth`.
- WhatsApp commands: `/menu`, `/developers`, `/activate ban_protection`, `/activate bug_protection`, `/activate soam_protection`.
- Native-flow menu with image header, quick replies and a WhatsApp Channel URL button. Native message rendering depends on WhatsApp client compatibility and must be verified with a linked account.
- Developer contact buttons for Lord Voyage and Calvin The Great.

## Protection behavior

### Ban Protection
When enabled, bot-generated replies are serialized per recipient, spaced by at least 1.8 seconds, limited to eight sends per recipient per minute and capped at 20 queued sends. It is a conservative outbound automation throttle, not a ban-prevention guarantee. It does not control messages sent manually from the linked phone or by other services.

### Bug Protection
When enabled, runtime errors and connection failures are recorded as security events. The Baileys reconnect loop uses exponential backoff with jitter and a bounded delay. Reconnect backoff is also used as a baseline reliability measure when the feature is disabled; activation adds detailed security-event capture and a longer bounded recovery window. This does not eliminate bugs or provider outages.

### SOAM Protection
SOAM means monitoring the bot against spam, suspicious activity, account abuse and malicious commands. When enabled, the bot monitors command attempts, records unauthorized command attempts, detects command bursts and repeated commands, and applies a temporary five-minute cooldown after eight command attempts in 60 seconds or five repetitions of the same command in that window. SOAM also records high-volume inbound bursts (40 messages per sender per minute) and repeated identical text patterns (15 repeats per minute), using a short hash rather than storing the message body. Owner-only command authorization is always enforced, even when SOAM is disabled. This cannot inspect WhatsApp's private enforcement systems, all linked-device actions or the user's phone.

## Local installation

Requirements: Node.js 20 or newer, npm, and a WhatsApp account you own or are authorized to link.

1. Copy `.env.example` to `.env`.
3. Set `OWNER_NUMBER` to the owner WhatsApp number in international digits-only format. Pairing requests are rejected unless the submitted number exactly matches this configured owner number.
4. Run `npm install`.
5. Run `npm run check`.
6. Run `npm start` and open `http://localhost:3000`.

SQLite is created at `DATA_DIR/whatsapp-protection.sqlite`; Baileys credentials are stored at `DATA_DIR/auth`. Never publish or commit this directory.

## Render deployment

1. Push the project to a private Git repository.
2. Create a Render Blueprint using `render.yaml`, or create a Docker Web Service.
3. Keep the persistent disk mounted at `/data` (the blueprint provisions a 1 GB disk).
4. Set `DATA_DIR=/data` and `OWNER_NUMBER` in the Render environment. The public pairing form only accepts the configured owner number.
5. Deploy and wait for `/api/health` to report `ok: true`.
6. Open `/pair`, enter the WhatsApp number with country code, and request a pairing code.
7. On the phone, open WhatsApp → Linked devices → Link a device → Link with phone number, then enter the displayed code.
8. Send `/menu` from the configured owner WhatsApp account to the linked bot chat.

Do not delete or replace the Render disk: it contains the Baileys session and SQLite database. Back it up securely. Treat `/data/auth` contents as secrets.

## API

Public endpoints:
- `GET /api/health` — service and database health indicator.
- `GET /api/status` — coarse WhatsApp connection state.
- `POST /api/pair-code` — body `{"phone":"2567XXXXXXXX"}`; returns a short-lived pairing token and code or `202` while Baileys prepares it.
- `GET /api/pair-code/status?token=...` — retrieves the code only for the matching unexpired pairing token.

The dashboard is read-only. There are no public administrator endpoints. Protection changes are performed through owner-only WhatsApp commands.

## Limitations and safety

- Pairing and real WhatsApp messaging require a live compatible WhatsApp account and network access; these cannot be fully tested without linking an account.
- Native-flow button appearance and callbacks must be tested with the deployed Baileys version and current WhatsApp clients.
- The bot does not scan the phone or uploaded files, detect all account compromise, reverse bans, or guarantee immunity from WhatsApp enforcement.
- Only pair accounts you own or are authorized to administer. Do not use the bot for unsolicited bulk messaging, spam, harassment or platform-limit evasion.
- WhatsApp Protection is an independent project and is not affiliated with WhatsApp or Meta. The WhatsApp Channel invitation is optional; the bot never follows it automatically.

## Verification

Run `npm run check` for JavaScript syntax checks. A live pairing, outbound messaging and interactive-button test requires dependency installation, deployment and an authorized WhatsApp account.

### Dashboard access
The dashboard is intentionally read-only and does not require an administrator token. It shows only basic service health. Protection controls, security-event logs, and WhatsApp session files are not exposed publicly. Enable protections using owner-only WhatsApp commands.
