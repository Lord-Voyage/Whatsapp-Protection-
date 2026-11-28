# Replit setup

This project is a Node.js 20.19+ Express service with a static website, SQLite storage, and a Baileys WhatsApp bot.

## Run the app

The Replit workflow starts the service with:

```sh
PORT=5000 npm start
```

Open the web preview for the pairing page. The health endpoint is `/api/health`; the read-only status dashboard is at `/dashboard`.

## WhatsApp pairing

The website and health endpoints work without a linked WhatsApp account. To enable bot commands and replies, pair an account you own or are authorized to link from the pairing page. Pairing state and the SQLite database are stored under `data/` by default; keep that directory persistent and private.

## Checks

Run `npm run check` for JavaScript syntax checks and `npm test` for the automated tests. Tests use temporary storage and fake WhatsApp sockets; they do not contact WhatsApp.
