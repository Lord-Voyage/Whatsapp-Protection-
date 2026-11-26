import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import pino from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, prepareWAMessageMedia } from '@whiskeysockets/baileys';

const require = createRequire(import.meta.url);
const { sendInteractiveMessage } = require('baileys_helper');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const DB_PATH = path.join(DATA_DIR, 'whatsapp-protection.sqlite');
fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS paired_numbers (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS linked_devices (
  phone TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','revoked')),
  session_status TEXT NOT NULL DEFAULT 'pairing',
  channel_followed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS protection_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, feature TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(phone, feature));
CREATE TABLE IF NOT EXISTS pairing_history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, event TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS activity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, event TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, sender TEXT, severity TEXT NOT NULL, event TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_security_created ON security_events(id DESC);
`);

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const insertLog = db.prepare('INSERT INTO activity_logs(phone,event,detail) VALUES(?,?,?)');
const insertPairEvent = db.prepare('INSERT INTO pairing_history(phone,event,detail) VALUES(?,?,?)');
const insertSecurityEvent = db.prepare('INSERT INTO security_events(phone,sender,severity,event,detail) VALUES(?,?,?,?,?)');
const pruneOldLogs = db.transaction(() => {
  db.prepare("DELETE FROM activity_logs WHERE datetime(created_at) < datetime('now','-90 days')").run();
  db.prepare("DELETE FROM security_events WHERE datetime(created_at) < datetime('now','-90 days')").run();
  db.prepare("DELETE FROM pairing_history WHERE datetime(created_at) < datetime('now','-90 days')").run();
});
pruneOldLogs();
const retentionTimer = setInterval(() => { try { pruneOldLogs(); } catch (error) { safeLogError(error, 'Log retention cleanup failed'); } }, 24 * 60 * 60 * 1000);
retentionTimer.unref();
const setPair = db.prepare(`INSERT INTO paired_numbers(phone,status) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET status=excluded.status,updated_at=CURRENT_TIMESTAMP`);
const upsertLinkedDevice = db.prepare(`INSERT INTO linked_devices(phone,status,session_status) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET status=excluded.status,session_status=excluded.session_status,updated_at=CURRENT_TIMESTAMP`);
const setLinkedSessionStatus = db.prepare(`UPDATE linked_devices SET session_status=?,updated_at=CURRENT_TIMESTAMP WHERE phone=?`);
const markChannelFollowed = db.prepare(`UPDATE linked_devices SET channel_followed=1,updated_at=CURRENT_TIMESTAMP WHERE phone=?`);
const getLinkedDevice = db.prepare(`SELECT * FROM linked_devices WHERE phone=?`);
const isLinkedAuthorized = db.prepare(`SELECT 1 AS ok FROM linked_devices WHERE phone=? AND status='active'`);
const upsertProtection = db.prepare(`INSERT INTO protection_settings(phone,feature,enabled) VALUES(?,?,?) ON CONFLICT(phone,feature) DO UPDATE SET enabled=excluded.enabled,updated_at=CURRENT_TIMESTAMP`);
let sock = null;
let currentPhone = null;
let currentStatus = 'disconnected';
let primaryPairingCode = null;
let primaryPairingToken = null;
let primaryPairingTokenExpires = 0;
const linkedSessions = new Map();
const linkedStartPromises = new Map();
const phonePairAttempts = new Map();
let reconnectTimer = null;
let reconnectAttempt = 0;
let shuttingDown = false;
let manualDisconnect = false;
const incomingAttempts = new Map();
const incomingMessageActivity = new Map();
const blockedSenders = new Map();
const outboundQueues = new Map();
const PAIRING_TOKEN_TTL = 10 * 60 * 1000;
const LINKED_AUTH_DIR = path.join(AUTH_DIR, 'linked');
const CHANNEL_CODE = '0029Vb84TTB1SWt2Fvyhtu2D';
fs.mkdirSync(LINKED_AUTH_DIR, { recursive: true });
const CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb84TTB1SWt2Fvyhtu2D';
const MENU_IMAGE = path.join(__dirname, 'public', 'assets', 'logo.png');

function featureEnabled(feature, phone = getOwnerPhone()) {
  if (!phone) return false;
  return Boolean(db.prepare('SELECT enabled FROM protection_settings WHERE phone=? AND feature=?').get(phone, feature)?.enabled);
}
function normalizePhone(value) {
  const phone = String(value || '').replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) throw new Error('Enter a valid international phone number (8–15 digits).');
  return phone;
}
function getOwnerPhone() {
  return String(process.env.OWNER_NUMBER || currentPhone || '').replace(/\D/g, '');
}
function safeLogError(error, context, phone = getOwnerPhone()) {
  log.error({ err: error, context }, context);
  if (featureEnabled('bug_protection', phone)) {
    try { insertSecurityEvent.run(phone || null, null, 'error', 'runtime_error', `${context}: ${String(error?.message || error).slice(0, 700)}`); } catch (_) {}
  }
}
function securityEvent(sender, severity, event, detail, phone = getOwnerPhone()) {
  try { insertSecurityEvent.run(phone || null, sender || null, severity, event, String(detail || '').slice(0, 1000)); } catch (error) { log.warn({ err: error }, 'Could not persist security event'); }
  try { insertLog.run(phone || null, `security_${event}`, `${sender || 'unknown'}: ${String(detail || '').slice(0, 500)}`); } catch (_) {}
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Outbound anti-spam guard: serializes replies and caps message bursts per destination.
async function sendBotPayload(jid, sendFn, phone = getOwnerPhone()) {
  if (!sock || currentStatus !== 'connected') return false;
  if (!featureEnabled('ban_protection', phone)) return sendFn(sock);
  const now = Date.now();
  let state = outboundQueues.get(jid);
  if (!state) state = { chain: Promise.resolve(), sent: [], queued: 0, lastSent: 0 };
  if (outboundQueues.size > 1500) { for (const [key, value] of outboundQueues) if (!value.queued && now - value.lastSent > 10 * 60_000) outboundQueues.delete(key); }
  if (state.queued >= 20) {
    securityEvent(jid.split('@')[0], 'high', 'outbound_queue_rejected', 'Outbound queue reached its 20-message safety limit', phone);
    outboundQueues.set(jid, state);
    return false;
  }
  state.queued += 1;
  const task = state.chain.then(async () => {
    const activeSock = sock;
    if (!activeSock || currentStatus !== 'connected') return false;
    const t = Date.now();
    state.sent = state.sent.filter(stamp => t - stamp < 60_000);
    if (state.sent.length >= 8) {
      const wait = Math.max(0, 60_000 - (t - state.sent[0]));
      if (wait > 0) await sleep(wait);
      const after = Date.now();
      state.sent = state.sent.filter(stamp => after - stamp < 60_000);
    }
    const spacing = Math.max(0, 1800 - (Date.now() - state.lastSent));
    if (spacing) await sleep(spacing);
    if (!sock || currentStatus !== 'connected') return false;
    const result = await sendFn(sock);
    state.lastSent = Date.now();
    state.sent.push(state.lastSent);
    return result ?? true;
  }).catch(error => { safeLogError(error, 'Protected outbound send failed', phone); return false; }).finally(() => { state.queued = Math.max(0, state.queued - 1); });
  state.chain = task;
  outboundQueues.set(jid, state);
  return task;
}

async function sendText(jid, text) {
  return sendBotPayload(jid, activeSock => activeSock.sendMessage(jid, { text }));
}
async function sendBrandedText(jid, title, body, buttons = [], phone = getOwnerPhone()) {
  if (!sock || currentStatus !== 'connected') return;
  const nativeButtons = buttons.map(button => ({
    name: button.url ? 'cta_url' : 'quick_reply',
    buttonParamsJson: JSON.stringify(button.url ? { display_text: button.label, url: button.url } : { display_text: button.label, id: button.id })
  }));
  const payload = { interactiveMessage: {
    header: { title: 'WhatsApp Protection' },
    body: { text: `*${title}*\n\n${body}` },
    footer: { text: 'WhatsApp Protection · Independent project' },
    ...(nativeButtons.length ? { nativeFlowMessage: { buttons: nativeButtons } } : {})
  }};
  return sendBotPayload(jid, activeSock => sendInteractiveMessage(activeSock, jid, payload), phone);
}

async function sendMenu(jid, phone) {
  if (!sock || currentStatus !== 'connected') return;
  const caption = [
    '*WHATSAPP PROTECTION*',
    '',
    'Welcome. Use the options below to manage your connected bot.',
    '',
    '*COMMANDS*',
    '/pair',
    '/menu',
    '/developers',
    '/activate ban_protection',
    '/activate bug_protection',
    '/activate soam_protection',
    '',
    'Independent security tooling. Not affiliated with WhatsApp or Meta.'
  ].join('\n');
  const uploadedMedia = await prepareWAMessageMedia({ image: fs.readFileSync(MENU_IMAGE) }, { upload: sock.waUploadToServer });
  const payload = { interactiveMessage: {
    header: { title: 'WhatsApp Protection', imageMessage: uploadedMedia.imageMessage, hasMediaAttachment: true },
    body: { text: caption },
    footer: { text: 'WhatsApp Protection · Independent project' },
    nativeFlowMessage: { buttons: [
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Developers', id: 'wp_developers' }) },
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Commands', id: 'wp_commands' }) },
      { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'WhatsApp Channel', url: CHANNEL_URL }) }
    ] }
  }};
  await sendBotPayload(jid, activeSock => sendInteractiveMessage(activeSock, jid, payload), phone);
  insertLog.run(phone, 'command_menu', '/menu');
}

function extractIncomingAction(message = {}) {
  const msg = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
  const text = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
  const buttonId = msg.buttonsResponseMessage?.selectedButtonId || msg.templateButtonReplyMessage?.selectedId || msg.listResponseMessage?.singleSelectReply?.selectedRowId || '';
  let nativeId = '';
  const params = msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (params) { try { const parsed = JSON.parse(params); nativeId = parsed.id || parsed.button_id || parsed.selected_id || ''; } catch (_) {} }
  return String(buttonId || nativeId || text).trim();
}
function observeInboundActivity(msg) {
  if (!featureEnabled('soam_protection') || !msg?.key || msg.key.fromMe) return;
  const sender = (msg.key.participant || msg.key.remoteJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!sender) return;
  const action = extractIncomingAction(msg.message || '');
  const now = Date.now();
  const state = (incomingMessageActivity.get(sender) || []).filter(item => now - item.at < 60_000);
  const digest = action ? crypto.createHash('sha256').update(action.trim().toLowerCase()).digest('hex').slice(0, 12) : 'nontext';
  state.push({ at: now, digest });
  incomingMessageActivity.set(sender, state);
  if (incomingMessageActivity.size > 3000) { for (const [key, value] of incomingMessageActivity) if (!value.length || now - value[value.length - 1].at > 10 * 60_000) incomingMessageActivity.delete(key); }
  const repeats = state.filter(item => item.digest === digest && digest !== 'nontext').length;
  if (state.length === 40) securityEvent(sender, 'medium', 'inbound_message_burst', '40 incoming messages observed from one sender within 60 seconds');
  if ((state.length === 60 || repeats === 15) && (blockedSenders.get(sender) || 0) <= now) {
    blockedSenders.set(sender, now + 5 * 60_000);
    securityEvent(sender, 'high', 'inbound_spam_pattern', `Suspicious inbound activity detected; count=${state.length}, repeated_payload_hash_count=${repeats}; 5-minute command cooldown applied`);
  }
}

function checkSoam(sender, action, phone = getOwnerPhone()) {
  if (!featureEnabled('soam_protection', phone)) return true;
  const now = Date.now();
  const blockedUntil = blockedSenders.get(sender) || 0;
  if (blockedUntil > now) {
    securityEvent(sender, 'medium', 'blocked_sender_command', `Command suppressed during temporary cooldown: ${action.slice(0, 100)}`, phone);
    return false;
  }
  const recent = (incomingAttempts.get(sender) || []).filter(item => now - item.at < 60_000);
  recent.push({ at: now, action: action.slice(0, 120) });
  incomingAttempts.set(sender, recent);
  const repeats = recent.filter(item => item.action.toLowerCase() === action.toLowerCase()).length;
  if (recent.length >= 8 || repeats >= 5) {
    blockedSenders.set(sender, now + 5 * 60_000);
    securityEvent(sender, 'high', 'command_abuse_cooldown', `Temporary 5-minute command cooldown; ${recent.length} command attempts in 60 seconds; repeated=${repeats}`, phone);
    return false;
  }
  if (recent.length >= 5) securityEvent(sender, 'medium', 'command_burst_detected', `${recent.length} command attempts in 60 seconds`, phone);
  return true;
}


async function followChannelForLinkedAccount(phone, activeSock) {
  const existing = getLinkedDevice.get(phone);
  if (existing?.channel_followed) return;
  try {
    if (typeof activeSock.newsletterMetadata !== 'function' || typeof activeSock.newsletterFollow !== 'function') throw new Error('This Baileys session does not expose WhatsApp Channel follow methods.');
    const metadata = await activeSock.newsletterMetadata('invite', CHANNEL_CODE);
    if (!metadata?.id) throw new Error('WhatsApp did not return a channel ID for the invite code.');
    await activeSock.newsletterFollow(metadata.id);
    markChannelFollowed.run(phone);
    insertPairEvent.run(phone, 'channel_followed', 'WhatsApp accepted the channel-follow request');
    insertLog.run(phone, 'channel_followed', CHANNEL_URL);
    log.info({ phone }, 'Linked account followed the configured WhatsApp Channel');
  } catch (error) {
    insertPairEvent.run(phone, 'channel_follow_failed', String(error?.message || error).slice(0, 500));
    safeLogError(error, 'Automatic WhatsApp Channel follow failed', phone);
  }
}

async function followChannelForPrimaryAccount(phone, activeSock) {
  if (getSystemConfig.get('primary_channel_followed')?.value === '1') return;
  try {
    if (typeof activeSock.newsletterMetadata !== 'function' || typeof activeSock.newsletterFollow !== 'function') throw new Error('This Baileys session does not expose WhatsApp Channel follow methods.');
    const metadata = await activeSock.newsletterMetadata('invite', CHANNEL_CODE);
    if (!metadata?.id) throw new Error('WhatsApp did not return a channel ID for the invite code.');
    await activeSock.newsletterFollow(metadata.id);
    setSystemConfig.run('primary_channel_followed', '1');
    insertPairEvent.run(phone || 'primary', 'channel_followed', 'Primary WhatsApp account followed the configured channel');
    insertLog.run(phone || null, 'channel_followed', CHANNEL_URL);
  } catch (error) {
    insertPairEvent.run(phone || 'primary', 'channel_follow_failed', String(error?.message || error).slice(0, 500));
    safeLogError(error, 'Primary account automatic channel follow failed', phone || getOwnerPhone());
  }
}

async function startLinkedSessionInternal(phone, { requestCode = false } = {}) {
  const existing = linkedSessions.get(phone);
  if (existing?.socket && ['pairing', 'connected', 'connecting'].includes(existing.status)) {
    if (existing.code) return existing.code;
    if (existing.status === 'connected') return null;
    throw new Error('A device-linking request for this number is already in progress.');
  }

  const authPath = path.join(LINKED_AUTH_DIR, phone);
  fs.mkdirSync(authPath, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); }
  catch (error) { log.warn({ err: error }, 'Could not fetch latest WhatsApp Web version for linked device'); }

  const record = {
    socket: null, status: state.creds.registered ? 'connecting' : 'pairing',
    code: null, codeExpiresAt: 0, reconnectTimer: null, reconnectAttempt: 0, intentionalClose: false
  };
  const activeSock = makeWASocket({
    auth: state, ...(version ? { version } : {}), printQRInTerminal: false,
    logger: log, browser: ['WhatsApp Protection', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false, syncFullHistory: false
  });
  record.socket = activeSock;
  linkedSessions.set(phone, record);
  activeSock.ev.on('creds.update', saveCreds);
  activeSock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      const registeredPhone = String(activeSock.user?.id || '').split(':')[0].split('@')[0].replace(/\D/g, '');
      if (registeredPhone && registeredPhone !== phone) {
        record.status = 'revoked';
        record.intentionalClose = true;
        upsertLinkedDevice.run(phone, 'revoked', 'number_mismatch');
        fs.rmSync(authPath, { recursive: true, force: true });
        insertPairEvent.run(phone, 'number_mismatch', `WhatsApp connected as ${registeredPhone}; expected ${phone}`);
        try { activeSock.end(new Error('Linked account number did not match requested number')); } catch (_) {}
        return;
      }
      record.status = 'connected'; record.code = null; record.reconnectAttempt = 0;
      upsertLinkedDevice.run(phone, 'active', 'connected');
      setPair.run(phone, 'connected');
      insertPairEvent.run(phone, 'connected', 'Independent Baileys device session connected');
      insertLog.run(phone, 'linked_device_connected', 'Independent Baileys session opened');
      await followChannelForLinkedAccount(phone, activeSock);
      log.info({ phone }, 'Independent linked WhatsApp session connected');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      record.status = loggedOut ? 'revoked' : 'connection_lost';
      setLinkedSessionStatus.run(loggedOut ? 'logged_out' : 'connection_lost', phone);
      if (loggedOut) {
        upsertLinkedDevice.run(phone, 'revoked', 'logged_out');
        fs.rmSync(authPath, { recursive: true, force: true });
        insertPairEvent.run(phone, 'logged_out', `WhatsApp logged out; status ${code ?? 'unknown'}`);
      } else {
        insertPairEvent.run(phone, 'connection_lost', `Disconnect status ${code ?? 'unknown'}`);
      }
      if (record.socket === activeSock) record.socket = null;
      if (!shuttingDown && !record.intentionalClose && !loggedOut) {
        record.reconnectAttempt += 1;
        const base = Math.min(300_000, 3000 * (2 ** Math.min(record.reconnectAttempt - 1, 7)));
        const delay = Math.min(300_000, base + Math.floor(Math.random() * Math.min(5000, Math.max(500, base * 0.2))));
        clearTimeout(record.reconnectTimer);
        record.reconnectTimer = setTimeout(() => {
          if (shuttingDown || record.intentionalClose) return;
          startLinkedSession(phone).catch(error => safeLogError(error, 'Linked WhatsApp session reconnect failed', phone));
        }, delay);
      }
    }
  });

  if (requestCode && !state.creds.registered) {
    try {
      const code = await activeSock.requestPairingCode(phone);
      if (record.socket !== activeSock || record.status === 'connection_lost' || record.status === 'revoked') throw new Error('WhatsApp disconnected before the device-linking code was ready. Send /pair again.');
      record.code = code; record.codeExpiresAt = Date.now() + PAIRING_TOKEN_TTL; record.status = 'pairing';
      upsertLinkedDevice.run(phone, 'pending', 'pairing_code_issued');
      setPair.run(phone, 'pairing');
      insertPairEvent.run(phone, 'pairing_code_generated', 'Genuine Baileys requestPairingCode result');
      insertLog.run(phone, 'pairing_code_generated', 'Device-linking code generated');
      return code;
    } catch (error) {
      record.intentionalClose = true;
      try { activeSock.end(error); } catch (_) {}
      linkedSessions.delete(phone);
      throw error;
    }
  }
  upsertLinkedDevice.run(phone, state.creds.registered ? 'active' : 'pending', state.creds.registered ? 'connecting' : 'pairing');
  return null;
}

async function startLinkedSession(phone, options = {}) {
  const inFlight = linkedStartPromises.get(phone);
  if (inFlight) return inFlight;
  const pending = startLinkedSessionInternal(phone, options);
  linkedStartPromises.set(phone, pending);
  try { return await pending; }
  finally { linkedStartPromises.delete(phone); }
}

async function createLinkedPairing(phone) {
  phone = normalizePhone(phone);
  const owner = getOwnerPhone();
  if (owner && phone === owner) throw new Error('The primary owner account is already connected to the main bot session.');
  const existing = getLinkedDevice.get(phone);
  const current = linkedSessions.get(phone);
  const activeCount = db.prepare("SELECT COUNT(*) AS count FROM linked_devices WHERE status='active'").get().count;
  const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM linked_devices WHERE status='pending'").get().count;
  if (!existing && activeCount >= 100) throw new Error('The service has reached its configured limit of 100 linked accounts.');
  if (pendingCount >= 20 && existing?.status !== 'pending') throw new Error('The service is handling too many pending pairing requests. Try again later.');
  if (existing?.status === 'active' && current?.status === 'connected') {
    return { code: null, status: 'connected', message: 'This WhatsApp number is already paired and connected.' };
  }
  if (current?.status === 'pairing' && current.code && current.codeExpiresAt > Date.now()) {
    return { code: current.code, status: 'pairing' };
  }
  if (current?.status === 'pairing' && current.code && current.codeExpiresAt <= Date.now()) {
    current.intentionalClose = true;
    try { current.socket?.end(new Error('Pairing code expired')); } catch (_) {}
    linkedSessions.delete(phone);
    fs.rmSync(path.join(LINKED_AUTH_DIR, phone), { recursive: true, force: true });
  }
  const attempts = (phonePairAttempts.get(phone) || []).filter(stamp => Date.now() - stamp < 30 * 60_000);
  if (attempts.length >= 3) throw new Error('This number has reached the pairing request limit. Wait 30 minutes before trying again.');
  attempts.push(Date.now()); phonePairAttempts.set(phone, attempts);

  const authPath = path.join(LINKED_AUTH_DIR, phone);
  const credsPath = path.join(authPath, 'creds.json');
  if (fs.existsSync(credsPath)) {
    let registered = false;
    try { registered = Boolean(JSON.parse(fs.readFileSync(credsPath, 'utf8')).registered); } catch (_) {}
    if (registered) {
      await startLinkedSession(phone);
      return { code: null, status: 'connecting', message: 'A saved WhatsApp device session exists. The service is reconnecting it; no new code is required.' };
    }
    fs.rmSync(authPath, { recursive: true, force: true });
  }
  upsertLinkedDevice.run(phone, 'pending', 'starting_pairing');
  const code = await startLinkedSession(phone, { requestCode: true });
  return { code, status: 'pairing' };
}

async function handleCommand(msg) {
  if (!msg.message || !msg.key?.remoteJid || msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  const senderJid = msg.key.participantAlt || msg.key.remoteJidAlt || msg.key.participant || jid;
  const sender = String(senderJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  const action = extractIncomingAction(msg.message);
  const looksLikeCommand = action.startsWith('/') || action.startsWith('wp_');
  if (!looksLikeCommand || !sender) return;
  const owner = getOwnerPhone();
  const isOwner = Boolean(owner && sender === owner);
  if (!checkSoam(sender, action, sender)) return;
  const command = action.toLowerCase();

  // /pair is intentionally available to unpaired users, but only from a private
  // chat: the incoming WhatsApp message itself proves control of the requesting number.
  if (command === '/pair') {
    if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) || msg.key.participant || sender.length < 8 || sender.length > 15) {
      await sendBotPayload(jid, activeSock => activeSock.sendMessage(jid, { text: 'For security, send /pair in a private chat with this bot, not in a group.' }), sender);
      return;
    }
    if (isOwner) {
      await sendBotPayload(jid, activeSock => activeSock.sendMessage(jid, { text: 'This number is already the primary bot owner. It does not need a second linked-device pairing.' }), sender);
      return;
    }
    try {
      const result = await createLinkedPairing(sender);
      if (result.code) {
        const reply = [
          '*WHATSAPP PROTECTION — DEVICE LINKING*',
          '',
          'Your genuine WhatsApp device-linking code is:',
          '',
          '```' + result.code + '```',
          '',
          'On the same phone number, open WhatsApp → Linked devices → Link a device → Link with phone number, then enter this code.',
          'Keep this code private. It expires shortly.',
          '',
          'After the account connects, it will be authorized to use the bot and the channel-follow request will run.'
        ].join('\n');
        await sendBotPayload(jid, activeSock => activeSock.sendMessage(jid, { text: reply }), sender);
      } else {
        await sendBotPayload(jid, activeSock => activeSock.sendMessage(jid, { text: result.message || 'This WhatsApp number is already paired.' }), sender);
      }
    } catch (error) {
      safeLogError(error, 'Device pairing command failed', sender);
      await sendBotPayload(jid, activeSock => activeSock.sendMessage(jid, { text: `Pairing could not be started: ${String(error.message || error).slice(0, 250)}` }), sender);
    }
    return;
  }

  const authorized = isOwner || Boolean(isLinkedAuthorized.get(sender));
  if (!authorized) {
    securityEvent(sender, 'medium', 'unauthorized_command_attempt', action.slice(0, 160), sender);
    return;
  }

  const phone = sender;
  if (command === '/menu' || command === 'wp_menu') { await sendMenu(jid, phone); return; }
  if (command === 'wp_commands') {
    await sendBrandedText(jid, 'COMMANDS', ['/pair', '/menu', '/developers', '/activate ban_protection', '/activate bug_protection', '/activate soam_protection'].join('\n'), [], phone);
    insertLog.run(phone, 'command_list_button', action); return;
  }
  if (command === 'wp_developers' || command === '/developers') {
    await sendBrandedText(jid, 'DEVELOPERS', 'Lord Voyage — +256 702 662 846\nhttps://wa.me/256702662846\n\nCalvin The Great — +256 766 808 269\nhttps://wa.me/256766808269', [
      { label: 'Lord Voyage', url: 'https://wa.me/256702662846' },
      { label: 'Calvin The Great', url: 'https://wa.me/256766808269' }
    ], phone);
    insertLog.run(phone, 'command_developers', action); return;
  }
  const match = command.match(/^\/activate\s+(ban_protection|bug_protection|soam_protection)$/);
  if (match) {
    const feature = match[1];
    upsertProtection.run(phone, feature, 1);
    insertLog.run(phone, 'protection_activated', feature);
    const messages = {
      ban_protection: 'Outbound anti-spam controls are now active. Bot replies are serialized, limited to 8 messages per destination per minute, spaced by at least 1.8 seconds, and capped at 20 queued messages. This reduces automation bursts but cannot guarantee immunity from WhatsApp bans.',
      bug_protection: 'Runtime error capture and connection recovery diagnostics are active. Reconnection uses exponential backoff with jitter and a bounded retry delay. This improves recovery but cannot eliminate software defects or service outages.',
      soam_protection: 'SOAM Protection is active. It monitors command abuse, repeated command attempts, unauthorized command attempts and suspicious command bursts. Repeated command abuse triggers a temporary 5-minute sender cooldown. It cannot inspect WhatsApp internal enforcement systems or guarantee account safety.'
    };
    await sendBrandedText(jid, 'PROTECTION ACTIVATED', messages[feature], [], phone);
    return;
  }
  const unknown = action.startsWith('/') ? action : '';
  if (unknown) {
    if (featureEnabled('soam_protection', phone)) securityEvent(sender, 'low', 'unknown_command', unknown.slice(0, 160), phone);
    await sendBrandedText(jid, 'UNKNOWN COMMAND', 'That command is not supported. Send /menu to see the available commands.', [], phone);
  }
}

async function startSocket(phoneForPairing = null, requestCode = false) {
  if (sock || shuttingDown) throw new Error('A WhatsApp session is already active or starting.');
  manualDisconnect = false;
  if (phoneForPairing) currentPhone = phoneForPairing;
  currentStatus = 'connecting';
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (error) { log.warn({ err: error }, 'Could not fetch latest WhatsApp Web version; using library default'); }
  const activeSock = makeWASocket({ auth: state, ...(version ? { version } : {}), printQRInTerminal: false, logger: log, browser: ['WhatsApp Protection', 'Chrome', '1.0.0'], markOnlineOnConnect: false, syncFullHistory: false });
  sock = activeSock;
  activeSock.ev.on('creds.update', saveCreds);
  activeSock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      currentStatus = 'connected'; primaryPairingCode = null; reconnectAttempt = 0;
      const registeredPhone = activeSock.user?.id?.split(':')[0]?.split('@')[0] || currentPhone;
      if (registeredPhone) { currentPhone = registeredPhone; setPair.run(registeredPhone, 'connected'); insertPairEvent.run(registeredPhone, 'connected', 'Baileys connection opened'); insertLog.run(registeredPhone, 'connection_open', 'WhatsApp connected'); }
      if (featureEnabled('bug_protection', registeredPhone)) insertSecurityEvent.run(registeredPhone, null, 'info', 'connection_recovered', 'WhatsApp connection opened successfully');
      log.info('WhatsApp connected');
      await followChannelForPrimaryAccount(registeredPhone, activeSock);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      currentStatus = manualDisconnect ? 'disconnected' : 'connection_lost';
      if (sock === activeSock) sock = null;
      if (currentPhone) { setPair.run(currentPhone, 'disconnected'); insertPairEvent.run(currentPhone, 'disconnected', `Disconnect status ${code ?? 'unknown'}`); }
      if (featureEnabled('bug_protection')) insertSecurityEvent.run(currentPhone || null, null, 'warning', 'connection_closed', `Disconnect status ${code ?? 'unknown'}`);
      if (!shuttingDown && !manualDisconnect && code !== DisconnectReason.loggedOut) {
        reconnectAttempt += 1;
        const base = Math.min(300_000, 3000 * (2 ** Math.min(reconnectAttempt - 1, 7)));
        const jitter = Math.floor(Math.random() * Math.min(5000, Math.max(500, base * 0.2)));
        const delay = Math.min(featureEnabled('bug_protection') ? 300_000 : 60_000, base + jitter);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => startSocket().catch(error => safeLogError(error, 'Reconnect attempt failed')), delay);
        log.warn({ attempt: reconnectAttempt, delay, statusCode: code }, 'Scheduling WhatsApp reconnect');
      }
    }
  });
  activeSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages || []) {
      try { observeInboundActivity(msg); await handleCommand(msg); } catch (error) { safeLogError(error, 'Command handler failed'); }
    }
  });
  if (requestCode && !state.creds.registered) {
    try {
      const code = await activeSock.requestPairingCode(phoneForPairing);
      primaryPairingCode = code;
      setPair.run(phoneForPairing, 'pairing');
      insertPairEvent.run(phoneForPairing, 'primary_pairing_code_generated', 'Primary owner device-linking code generated');
      return code;
    } catch (error) {
      manualDisconnect = true;
      try { activeSock.end(error); } catch (_) {}
      if (sock === activeSock) sock = null;
      currentStatus = 'connection_lost';
      throw error;
    }
  }
  return null;
}

// Express and security middleware
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
const limitBuckets = new Map();
function rateLimit({ limit = 5, windowMs = 60_000 } = {}) {
  return (req, res, next) => {
    const key = req.ip || 'unknown'; const now = Date.now();
    const recent = (limitBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (limitBuckets.size > 3000) { for (const [ip, stamps] of limitBuckets) if (!stamps.some(t => now - t < windowMs)) limitBuckets.delete(ip); }
    if (recent.length >= limit) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    recent.push(now); limitBuckets.set(key, recent); next();
  };
}
app.use('/api/pair-code', rateLimit({ limit: 5 }));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'whatsapp-protection', status: currentStatus, database: fs.existsSync(DB_PATH) }));
app.get('/api/status', (_req, res) => res.json({ status: currentStatus, connected: currentStatus === 'connected' }));
// Website bootstrap pairing is restricted to OWNER_NUMBER. Additional accounts must
// initiate /pair from their own private WhatsApp chat to prove control of that number.
app.post('/api/pair-code', async (req, res) => {
  try {
    if (!process.env.OWNER_NUMBER) return res.status(503).json({ error: 'Set OWNER_NUMBER in the service environment before pairing the primary bot account.' });
    const phone = normalizePhone(req.body?.phone);
    const owner = normalizePhone(process.env.OWNER_NUMBER);
    if (phone !== owner) return res.status(403).json({ error: 'Website pairing is only for the configured primary owner. Other users must send /pair in a private WhatsApp chat with the bot.' });
    if (sock || currentStatus === 'connected') return res.status(409).json({ error: 'The primary WhatsApp session is already active or connecting.' });
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (fs.existsSync(credsPath)) {
      try {
        if (JSON.parse(fs.readFileSync(credsPath, 'utf8')).registered) return res.status(409).json({ error: 'The primary WhatsApp account is already registered. Restore its saved session or securely reset DATA_DIR/auth to pair again.' });
      } catch (_) {}
    }
    primaryPairingToken = crypto.randomBytes(24).toString('hex');
    primaryPairingTokenExpires = Date.now() + PAIRING_TOKEN_TTL;
    primaryPairingCode = null;
    const code = await startSocket(phone, true);
    if (!code) return res.status(202).json({ status: currentStatus, pairingToken: primaryPairingToken, expiresInSeconds: 600, message: 'Pairing started. Waiting for the code…' });
    res.json({ status: currentStatus, pairingToken: primaryPairingToken, code, expiresInSeconds: 600 });
  } catch (error) {
    safeLogError(error, 'Primary owner pairing request failed');
    res.status(400).json({ error: error.message || 'Could not generate a primary device-linking code.' });
  }
});
app.get('/api/pair-code/status', (req, res) => {
  const token = String(req.query.token || '');
  if (!token || token !== primaryPairingToken || Date.now() > primaryPairingTokenExpires) return res.status(403).json({ error: 'Invalid or expired pairing request token.' });
  res.json({ code: primaryPairingCode, status: currentStatus, connected: currentStatus === 'connected' });
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/pair', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'pair.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(PORT, () => log.info(`WhatsApp Protection listening on ${PORT}`));
async function bootExistingSession() {
  const credsFile = path.join(AUTH_DIR, 'creds.json');
  if (fs.existsSync(credsFile)) { try { await startSocket(); } catch (error) { safeLogError(error, 'Could not restore existing WhatsApp session'); } }
}
bootExistingSession();
async function bootLinkedSessions() {
  const rows = db.prepare("SELECT phone FROM linked_devices WHERE status='active'").all();
  for (const row of rows) {
    try { await startLinkedSession(row.phone); }
    catch (error) { safeLogError(error, 'Could not restore linked device session', row.phone); }
  }
}
bootLinkedSessions();
process.on('unhandledRejection', error => safeLogError(error, 'Unhandled promise rejection'));
process.on('uncaughtException', error => { safeLogError(error, 'Uncaught exception'); process.exit(1); });
async function shutdown() {
  shuttingDown = true; if (reconnectTimer) clearTimeout(reconnectTimer); clearInterval(retentionTimer);
  try { sock?.end(new Error('Server shutting down')); } catch (_) {}
  for (const record of linkedSessions.values()) {
    record.intentionalClose = true;
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    try { record.socket?.end(new Error('Server shutting down')); } catch (_) {}
  }
  server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
