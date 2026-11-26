import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import pino from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, fetchLatestWaWebVersion, prepareWAMessageMedia } from '@whiskeysockets/baileys';

const require = createRequire(import.meta.url);
const { sendInteractiveMessage } = require('baileys_helper');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const MAX_LINKED_ACCOUNTS = Math.max(0, Number.parseInt(process.env.MAX_LINKED_ACCOUNTS ?? '100', 10) || 0);
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const DB_PATH = path.join(DATA_DIR, 'whatsapp-protection.sqlite');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

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
// Baileys is very verbose at info/debug level; keep its output separate and quieter by default.
const waLogger = log.child({ module: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL || 'warn' });
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
const getProtection = db.prepare('SELECT enabled FROM protection_settings WHERE phone=? AND feature=?');
const getSystemConfig = db.prepare('SELECT value FROM system_config WHERE key=?');
const setSystemConfig = db.prepare(`INSERT INTO system_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`);
const deletePendingLinkedDevice = db.prepare(`DELETE FROM linked_devices WHERE phone=? AND status='pending'`);
const countLinkedByStatus = db.prepare('SELECT COUNT(*) AS count FROM linked_devices WHERE status=?');
const PROTECTION_FEATURES = ['ban_protection', 'bug_protection', 'soam_protection'];
let sock = null;
let currentPhone = null;
let currentStatus = 'disconnected';
let primaryPairingCode = null;
let primaryPairingToken = null;
let primaryPairingTokenExpires = 0;
let primaryPairingTimer = null;
let primaryPairingDeadline = 0;
const channelFollowInFlight = new Set();
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
const PAIRING_QR_REF_MS = 2 * 60 * 1000;
// WhatsApp's server ends an unlinked pairing connection after roughly 3.5 minutes (status 428),
// which invalidates its code. Until the pairing deadline, a fresh genuine code is requested.
const PAIRING_REFRESH_MARGIN_MS = 30_000;
function pairingRefreshAllowed(deadline, now = Date.now()) { return Boolean(deadline) && now < deadline - PAIRING_REFRESH_MARGIN_MS; }
const LINKED_AUTH_DIR = path.join(AUTH_DIR, 'linked');
const CHANNEL_CODE = '0029Vb84TTB1SWt2Fvyhtu2D';
fs.mkdirSync(LINKED_AUTH_DIR, { recursive: true });
const CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb84TTB1SWt2Fvyhtu2D';
const MENU_IMAGE = path.join(__dirname, 'public', 'assets', 'logo.png');

function featureEnabled(feature, phone = getOwnerPhone()) {
  if (!phone) return false;
  try { return Boolean(getProtection.get(phone, feature)?.enabled); }
  catch (error) { log.warn({ err: error, feature }, 'Could not read protection setting'); return false; }
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
function phoneFromJid(jid) {
  const value = String(jid || '');
  if (!value.endsWith('@s.whatsapp.net')) return '';
  return value.split('@')[0].split(':')[0].replace(/\D/g, '');
}
function jidUser(jid) { return String(jid || '').split('@')[0].split(':')[0]; }
function isRegisteredCredsFile(credsPath) {
  try { return Boolean(JSON.parse(fs.readFileSync(credsPath, 'utf8')).registered); } catch (_) { return false; }
}
// Removes the primary account's Baileys files without touching linked-account directories.
function clearPrimaryAuth() {
  for (const entry of fs.readdirSync(AUTH_DIR)) {
    if (entry === 'linked') continue;
    fs.rmSync(path.join(AUTH_DIR, entry), { recursive: true, force: true });
  }
}
let cachedWaVersion = null;
let cachedWaVersionAt = 0;
async function resolveWaVersion() {
  if (cachedWaVersion && Date.now() - cachedWaVersionAt < 6 * 60 * 60_000) return cachedWaVersion;
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out fetching WhatsApp Web version')), 10_000).unref());
    // WhatsApp rejects device links from stale web versions, so prefer the live web.whatsapp.com version.
    for (const fetchVersion of [fetchLatestWaWebVersion, fetchLatestBaileysVersion]) {
      const { version, isLatest } = await Promise.race([fetchVersion(), timeout]);
      if (isLatest && Array.isArray(version)) { cachedWaVersion = version; cachedWaVersionAt = Date.now(); break; }
    }
  } catch (error) { log.warn({ err: error }, 'Could not fetch latest WhatsApp Web version; using library default'); }
  return cachedWaVersion;
}

// Socket options shared by the primary and linked sessions. Baileys only emits pairing-code
// "qr" refs for a few minutes by default and then closes the socket, which makes WhatsApp
// answer "Couldn't link device" if the code is entered late; keep the socket alive for the
// whole pairing window instead. A standard browser identity is required for code linking.
function waSocketOptions(auth, version) {
  return {
    auth, ...(version ? { version } : {}), logger: waLogger, printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'), qrTimeout: PAIRING_QR_REF_MS,
    markOnlineOnConnect: false, syncFullHistory: false
  };
}

// Replies go out through the socket that received the command: the primary bot, or a linked
// user's own session when they command it from their "Message yourself" chat.
const replyContext = new AsyncLocalStorage();
function replySocket() {
  const ctx = replyContext.getStore();
  if (ctx) return ctx.isOpen() ? ctx.socket : null;
  return sock && currentStatus === 'connected' ? sock : null;
}

// Outbound anti-spam guard: serializes replies and caps message bursts per destination.
async function sendBotPayload(jid, sendFn, phone = getOwnerPhone()) {
  const ctx = replyContext.getStore();
  const currentSocket = () => (ctx ? (ctx.isOpen() ? ctx.socket : null) : replySocket());
  if (!currentSocket()) return false;
  if (!featureEnabled('ban_protection', phone)) return sendFn(currentSocket());
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
    if (!currentSocket()) return false;
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
    const activeSock = currentSocket();
    if (!activeSock) return false;
    const result = await sendFn(activeSock);
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
  if (!replySocket()) return;
  const nativeButtons = buttons.map(button => ({
    name: button.url ? 'cta_url' : 'quick_reply',
    buttonParamsJson: JSON.stringify(button.url ? { display_text: button.label, url: button.url } : { display_text: button.label, id: button.id })
  }));
  const text = `*${title}*\n\n${body}`;
  if (!nativeButtons.length) return sendBotPayload(jid, activeSock => activeSock.sendMessage(jid, { text }), phone);
  const payload = { interactiveMessage: {
    header: { title: 'WhatsApp Protection' },
    body: { text },
    footer: { text: 'WhatsApp Protection · Independent project' },
    nativeFlowMessage: { buttons: nativeButtons }
  }};
  return sendBotPayload(jid, async activeSock => {
    try { return await sendInteractiveMessage(activeSock, jid, payload); }
    catch (error) {
      log.warn({ err: error }, 'Interactive message failed; sending plain-text fallback');
      const links = buttons.filter(button => button.url).map(button => `${button.label}: ${button.url}`).join('\n');
      return activeSock.sendMessage(jid, { text: links ? `${text}\n\n${links}` : text });
    }
  }, phone);
}

async function sendMenu(jid, phone) {
  if (!replySocket()) return;
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
    '/deactivate <feature>',
    '/status',
    '',
    'Independent security tooling. Not affiliated with WhatsApp or Meta.'
  ].join('\n');
  await sendBotPayload(jid, async activeSock => {
    try {
      const uploadedMedia = await prepareWAMessageMedia({ image: fs.readFileSync(MENU_IMAGE) }, { upload: activeSock.waUploadToServer });
      return await sendInteractiveMessage(activeSock, jid, buildMenuPayload(caption, uploadedMedia));
    } catch (error) {
      log.warn({ err: error }, 'Interactive menu failed; sending plain-text fallback');
      return activeSock.sendMessage(jid, { text: `${caption}\n\nWhatsApp Channel: ${CHANNEL_URL}` });
    }
  }, phone);
  insertLog.run(phone, 'command_menu', '/menu');
}

function buildMenuPayload(caption, uploadedMedia) {
  return { interactiveMessage: {
    header: { title: 'WhatsApp Protection', imageMessage: uploadedMedia.imageMessage, hasMediaAttachment: true },
    body: { text: caption },
    footer: { text: 'WhatsApp Protection · Independent project' },
    nativeFlowMessage: { buttons: [
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Developers', id: 'wp_developers' }) },
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Commands', id: 'wp_commands' }) },
      { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'WhatsApp Channel', url: CHANNEL_URL }) }
    ] }
  }};
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
  if (blockedUntil) blockedSenders.delete(sender);
  const recent = (incomingAttempts.get(sender) || []).filter(item => now - item.at < 60_000);
  recent.push({ at: now, action: action.slice(0, 120) });
  incomingAttempts.set(sender, recent);
  if (incomingAttempts.size > 3000) { for (const [key, value] of incomingAttempts) if (!value.some(item => now - item.at < 60_000)) incomingAttempts.delete(key); }
  if (blockedSenders.size > 3000) { for (const [key, until] of blockedSenders) if (until <= now) blockedSenders.delete(key); }
  const repeats = recent.filter(item => item.action.toLowerCase() === action.toLowerCase()).length;
  if (recent.length >= 8 || repeats >= 5) {
    blockedSenders.set(sender, now + 5 * 60_000);
    securityEvent(sender, 'high', 'command_abuse_cooldown', `Temporary 5-minute command cooldown; ${recent.length} command attempts in 60 seconds; repeated=${repeats}`, phone);
    return false;
  }
  if (recent.length >= 5) securityEvent(sender, 'medium', 'command_burst_detected', `${recent.length} command attempts in 60 seconds`, phone);
  return true;
}


// Resolves the configured channel invite and asks WhatsApp to follow it. Resolves only when
// WhatsApp's GraphQL endpoint returns a successful response; any error response throws.
async function followConfiguredChannel(activeSock) {
  if (typeof activeSock?.newsletterMetadata !== 'function' || typeof activeSock?.newsletterFollow !== 'function') throw new Error('This Baileys session does not expose WhatsApp Channel follow methods.');
  const metadata = await activeSock.newsletterMetadata('invite', CHANNEL_CODE);
  if (!metadata?.id) throw new Error('WhatsApp did not return a channel ID for the invite code.');
  await activeSock.newsletterFollow(metadata.id);
  return metadata.id;
}

async function followChannelForLinkedAccount(phone, activeSock) {
  const key = `linked:${phone}`;
  if (channelFollowInFlight.has(key)) return false;
  channelFollowInFlight.add(key);
  try {
    if (getLinkedDevice.get(phone)?.channel_followed) return true;
    await followConfiguredChannel(activeSock);
    markChannelFollowed.run(phone);
    insertPairEvent.run(phone, 'channel_followed', 'WhatsApp accepted the channel-follow request');
    insertLog.run(phone, 'channel_followed', CHANNEL_URL);
    log.info({ phone }, 'Linked account followed the configured WhatsApp Channel');
    return true;
  } catch (error) {
    try { insertPairEvent.run(phone, 'channel_follow_failed', String(error?.message || error).slice(0, 500)); } catch (_) {}
    safeLogError(error, 'Automatic WhatsApp Channel follow failed', phone);
    return false;
  } finally {
    channelFollowInFlight.delete(key);
  }
}

// The primary account has no linked_devices row, so its follow state lives in system_config,
// keyed to the phone number that followed (re-pairing a different number triggers a new follow).
async function followChannelForPrimaryAccount(phone, activeSock) {
  const key = 'primary';
  if (channelFollowInFlight.has(key)) return false;
  channelFollowInFlight.add(key);
  const label = phone || 'primary';
  try {
    const followed = getSystemConfig.get('primary_channel_followed')?.value;
    if (followed && followed === label) return true;
    await followConfiguredChannel(activeSock);
    setSystemConfig.run('primary_channel_followed', label);
    insertPairEvent.run(label, 'channel_followed', 'WhatsApp accepted the primary account channel-follow request');
    insertLog.run(phone || null, 'channel_followed', CHANNEL_URL);
    log.info({ phone }, 'Primary account followed the configured WhatsApp Channel');
    return true;
  } catch (error) {
    try { insertPairEvent.run(label, 'channel_follow_failed', String(error?.message || error).slice(0, 500)); } catch (_) {}
    safeLogError(error, 'Primary account automatic channel follow failed', phone || getOwnerPhone());
    return false;
  } finally {
    channelFollowInFlight.delete(key);
  }
}

// Ends an unfinished linked-device pairing: closes its socket, removes its unregistered auth
// directory and deletes the pending database row so it no longer counts toward pending limits.
// requestPairingCode must wait until WhatsApp has opened the socket and offered a pairing
// challenge (signalled by the first `qr` update); calling it earlier fails with "Connection Closed".
function waitForPairingChallenge(activeSock, timeoutMs = 30_000) {
  const ready = new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); activeSock.ev.off('connection.update', onUpdate); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for WhatsApp to accept a device-linking request.')); }, timeoutMs);
    const onUpdate = update => {
      if (update.qr) { cleanup(); resolve(); }
      else if (update.connection === 'close') { cleanup(); reject(new Error('WhatsApp closed the connection before a device-linking code could be requested.')); }
    };
    activeSock.ev.on('connection.update', onUpdate);
  });
  ready.catch(() => {});
  return ready;
}

function refreshLinkedPairing(phone, record, statusCode) {
  clearTimeout(record.expiryTimer);
  record.code = null;
  fs.rmSync(path.join(LINKED_AUTH_DIR, phone), { recursive: true, force: true });
  insertPairEvent.run(phone, 'pairing_code_refreshing', `WhatsApp closed the unlinked pairing connection; status ${statusCode ?? 'unknown'}`);
  startLinkedSession(phone, { requestCode: true, pairingDeadline: record.pairingDeadline, onCode: record.onCode, refresh: true })
    .catch(error => safeLogError(error, 'Pairing code refresh failed', phone));
}

function cleanupLinkedPairing(phone, record, reason) {
  record.intentionalClose = true;
  record.status = 'expired';
  record.code = null;
  clearTimeout(record.expiryTimer);
  clearTimeout(record.reconnectTimer);
  try { record.socket?.end(new Error(reason)); } catch (_) {}
  record.socket = null;
  if (linkedSessions.get(phone) === record) linkedSessions.delete(phone);
  const authPath = path.join(LINKED_AUTH_DIR, phone);
  if (!isRegisteredCredsFile(path.join(authPath, 'creds.json'))) fs.rmSync(authPath, { recursive: true, force: true });
  try {
    deletePendingLinkedDevice.run(phone);
    insertPairEvent.run(phone, 'pairing_ended', reason);
  } catch (error) { log.warn({ err: error, phone }, 'Could not record pairing cleanup'); }
}

async function startLinkedSessionInternal(phone, { requestCode = false, pairingDeadline = 0, onCode = null, refresh = false } = {}) {
  const existing = linkedSessions.get(phone);
  if (existing?.socket && ['pairing', 'connected', 'connecting'].includes(existing.status)) {
    if (existing.code && existing.codeExpiresAt > Date.now()) return existing.code;
    if (existing.status === 'connected') return null;
    throw new Error('A device-linking request for this number is already in progress.');
  }
  if (existing) { clearTimeout(existing.reconnectTimer); clearTimeout(existing.expiryTimer); }

  const authPath = path.join(LINKED_AUTH_DIR, phone);
  fs.mkdirSync(authPath, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const version = await resolveWaVersion();

  const record = {
    socket: null, status: state.creds.registered ? 'connecting' : 'pairing',
    code: null, codeExpiresAt: 0, reconnectTimer: null, expiryTimer: null,
    reconnectAttempt: existing?.reconnectAttempt || 0, intentionalClose: false
  };
  const activeSock = makeWASocket(waSocketOptions(state, version));
  const pairingReady = requestCode && !state.creds.registered ? waitForPairingChallenge(activeSock) : null;
  record.socket = activeSock;
  linkedSessions.set(phone, record);
  activeSock.ev.on('creds.update', saveCreds);
  // A linked user runs the bot on their own account: only their own messages in their
  // "Message yourself" chat are commands; messages other people send them are ignored.
  const linkedReplyContext = { socket: activeSock, isOpen: () => record.socket === activeSock && record.status === 'connected' };
  activeSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages || []) {
      if (!msg?.key?.fromMe) continue;
      try { await replyContext.run(linkedReplyContext, () => handleCommand(msg, activeSock)); }
      catch (error) { safeLogError(error, 'Linked command handler failed', phone); }
    }
  });
  activeSock.ev.on('connection.update', async update => {
    try {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        clearTimeout(record.expiryTimer);
        const registeredPhone = phoneFromJid(activeSock.user?.id);
        if (registeredPhone && registeredPhone !== phone) {
          record.status = 'revoked';
          record.intentionalClose = true;
          upsertLinkedDevice.run(phone, 'revoked', 'number_mismatch');
          insertPairEvent.run(phone, 'number_mismatch', `WhatsApp connected as ${registeredPhone}; expected ${phone}`);
          try { activeSock.end(new Error('Linked account number did not match requested number')); } catch (_) {}
          fs.rmSync(authPath, { recursive: true, force: true });
          if (linkedSessions.get(phone) === record) linkedSessions.delete(phone);
          return;
        }
        record.status = 'connected'; record.code = null; record.reconnectAttempt = 0;
        upsertLinkedDevice.run(phone, 'active', 'connected');
        setPair.run(phone, 'connected');
        insertPairEvent.run(phone, 'connected', 'Independent Baileys device session connected');
        insertLog.run(phone, 'linked_device_connected', 'Independent Baileys session opened');
        log.info({ phone }, 'Independent linked WhatsApp session connected');
        await followChannelForLinkedAccount(phone, activeSock);
      }
      if (connection === 'close') {
        if (record.socket !== activeSock) return;
        record.socket = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        // Unregistered sockets can only continue after WhatsApp's post-pairing restart request.
        const canReconnect = state.creds.registered || code === DisconnectReason.restartRequired;
        if (record.intentionalClose || shuttingDown) return;
        if (loggedOut) {
          record.status = 'revoked';
          clearTimeout(record.expiryTimer);
          upsertLinkedDevice.run(phone, 'revoked', 'logged_out');
          fs.rmSync(authPath, { recursive: true, force: true });
          insertPairEvent.run(phone, 'logged_out', `WhatsApp logged out; status ${code ?? 'unknown'}`);
          if (linkedSessions.get(phone) === record) linkedSessions.delete(phone);
          return;
        }
        if (!canReconnect) {
          if (record.status === 'pairing' && record.code && pairingRefreshAllowed(record.pairingDeadline)) {
            refreshLinkedPairing(phone, record, code);
            return;
          }
          cleanupLinkedPairing(phone, record, `Pairing ended before the device was linked; status ${code ?? 'unknown'}`);
          return;
        }
        record.status = 'connection_lost';
        setLinkedSessionStatus.run('connection_lost', phone);
        insertPairEvent.run(phone, 'connection_lost', `Disconnect status ${code ?? 'unknown'}`);
        record.reconnectAttempt += 1;
        const base = code === DisconnectReason.restartRequired ? 1000 : Math.min(300_000, 3000 * (2 ** Math.min(record.reconnectAttempt - 1, 7)));
        const delay = Math.min(300_000, base + Math.floor(Math.random() * Math.min(5000, Math.max(500, base * 0.2))));
        clearTimeout(record.reconnectTimer);
        record.reconnectTimer = setTimeout(() => {
          if (shuttingDown || record.intentionalClose || linkedSessions.get(phone) !== record) return;
          startLinkedSession(phone).catch(error => safeLogError(error, 'Linked WhatsApp session reconnect failed', phone));
        }, delay);
      }
    } catch (error) {
      safeLogError(error, 'Linked session connection handler failed', phone);
    }
  });

  if (requestCode && !state.creds.registered) {
    try {
      await pairingReady;
      if (record.socket !== activeSock) throw new Error('WhatsApp disconnected before the device-linking code was ready. Send /pair again.');
      const code = await activeSock.requestPairingCode(phone);
      if (record.socket !== activeSock || !['pairing', 'connecting'].includes(record.status)) throw new Error('WhatsApp disconnected before the device-linking code was ready. Send /pair again.');
      record.pairingDeadline = pairingDeadline || Date.now() + PAIRING_TOKEN_TTL;
      record.onCode = onCode;
      record.code = code; record.codeExpiresAt = record.pairingDeadline; record.status = 'pairing';
      record.expiryTimer = setTimeout(() => {
        if (linkedSessions.get(phone) === record && record.status !== 'connected') cleanupLinkedPairing(phone, record, 'Pairing code expired before the device was linked');
      }, Math.max(1000, record.pairingDeadline - Date.now()));
      record.expiryTimer.unref?.();
      upsertLinkedDevice.run(phone, 'pending', 'pairing_code_issued');
      setPair.run(phone, 'pairing');
      insertPairEvent.run(phone, refresh ? 'pairing_code_refreshed' : 'pairing_code_generated', 'Genuine Baileys requestPairingCode result');
      insertLog.run(phone, 'pairing_code_generated', 'Device-linking code generated');
      if (refresh && onCode) Promise.resolve(onCode(code)).catch(error => safeLogError(error, 'Could not deliver refreshed pairing code', phone));
      return code;
    } catch (error) {
      cleanupLinkedPairing(phone, record, `Pairing code request failed: ${String(error?.message || error).slice(0, 200)}`);
      throw error;
    }
  }
  if (!state.creds.registered) {
    // Never leave an unregistered socket running without an active pairing code.
    cleanupLinkedPairing(phone, record, 'Saved linked-device credentials were not registered');
    return null;
  }
  upsertLinkedDevice.run(phone, 'active', 'connecting');
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

async function createLinkedPairing(phone, { onCodeRefresh = null } = {}) {
  phone = normalizePhone(phone);
  const owner = getOwnerPhone();
  if (owner && phone === owner) throw new Error('The primary owner account is already connected to the main bot session.');
  const existing = getLinkedDevice.get(phone);
  const current = linkedSessions.get(phone);
  const activeCount = countLinkedByStatus.get('active').count;
  const pendingCount = countLinkedByStatus.get('pending').count;
  // Pending pairings reserve a slot so concurrent requests cannot overshoot the cap.
  const reservedCount = activeCount + pendingCount - (existing?.status === 'pending' ? 1 : 0);
  if (MAX_LINKED_ACCOUNTS && existing?.status !== 'active' && reservedCount >= MAX_LINKED_ACCOUNTS) throw new Error(`This server has reached its configured limit of ${MAX_LINKED_ACCOUNTS} linked accounts (MAX_LINKED_ACCOUNTS).`);
  if (pendingCount >= 20 && existing?.status !== 'pending') throw new Error('The service is handling too many pending pairing requests. Try again later.');
  if (existing?.status === 'active' && current?.status === 'connected') {
    return { code: null, status: 'connected', message: 'This WhatsApp number is already paired and connected.' };
  }
  if (current?.status === 'pairing' && current.code && current.codeExpiresAt > Date.now()) {
    return { code: current.code, status: 'pairing' };
  }
  if (current?.status === 'pairing' && current.code && current.codeExpiresAt <= Date.now()) {
    cleanupLinkedPairing(phone, current, 'Pairing code expired');
  }
  const attempts = (phonePairAttempts.get(phone) || []).filter(stamp => Date.now() - stamp < 30 * 60_000);
  if (attempts.length >= 3) throw new Error('This number has reached the pairing request limit. Wait 30 minutes before trying again.');
  attempts.push(Date.now()); phonePairAttempts.set(phone, attempts);
  if (phonePairAttempts.size > 3000) { for (const [key, stamps] of phonePairAttempts) if (!stamps.some(stamp => Date.now() - stamp < 30 * 60_000)) phonePairAttempts.delete(key); }

  const authPath = path.join(LINKED_AUTH_DIR, phone);
  const credsPath = path.join(authPath, 'creds.json');
  if (fs.existsSync(credsPath)) {
    if (isRegisteredCredsFile(credsPath)) {
      await startLinkedSession(phone);
      return { code: null, status: 'connecting', message: 'A saved WhatsApp device session exists. The service is reconnecting it; no new code is required.' };
    }
    fs.rmSync(authPath, { recursive: true, force: true });
  }
  upsertLinkedDevice.run(phone, 'pending', 'starting_pairing');
  const code = await startLinkedSession(phone, { requestCode: true, onCode: onCodeRefresh });
  return { code, status: 'pairing' };
}

// Resolves the sender's phone number. Only phone-number JIDs are trusted; WhatsApp LIDs are
// opaque identifiers and must never be treated as phone numbers (e.g. for /pair).
function resolveCommandSender(msg, activeSock = sock) {
  const jid = msg.key.remoteJid;
  if (msg.key.fromMe) {
    // The primary bot runs on the owner's own account, so the owner issues commands from
    // their "Message yourself" chat. Other outgoing messages are never treated as commands.
    const ownPhone = phoneFromJid(activeSock?.user?.id);
    const ownIds = [jidUser(activeSock?.user?.id), jidUser(activeSock?.user?.lid)].filter(Boolean);
    const chatUsers = [jidUser(jid), jidUser(msg.key.remoteJidAlt)].filter(Boolean);
    if (!ownPhone || !chatUsers.some(user => ownIds.includes(user))) return '';
    return ownPhone;
  }
  for (const candidate of [msg.key.participantAlt, msg.key.remoteJidAlt, msg.key.participant, jid]) {
    const phone = phoneFromJid(candidate);
    if (phone) return phone;
  }
  return '';
}

async function handleCommand(msg, activeSock = sock) {
  if (!msg?.message || !msg.key?.remoteJid) return;
  const jid = msg.key.remoteJid;
  const action = extractIncomingAction(msg.message);
  const looksLikeCommand = action.startsWith('/') || action.startsWith('wp_');
  if (!looksLikeCommand) return;
  const sender = resolveCommandSender(msg, activeSock);
  if (!sender) {
    if (!msg.key.fromMe && action.toLowerCase() === '/pair' && !msg.key.participant) {
      await sendBotPayload(jid, s => s.sendMessage(jid, { text: 'Your phone number could not be verified from this chat. Make sure your number is visible to the bot and try /pair again.' }));
    }
    return;
  }
  if (sender.length < 8 || sender.length > 15) return;
  const owner = getOwnerPhone();
  const isOwner = Boolean(owner && sender === owner);
  if (!checkSoam(sender, action, sender)) return;
  const command = action.toLowerCase().replace(/\s+/g, ' ');

  // /pair is intentionally available to unpaired users, but only from a private
  // chat: the incoming WhatsApp message itself proves control of the requesting number.
  if (command === '/pair') {
    if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) || msg.key.participant) {
      await sendBotPayload(jid, activeSock => activeSock.sendMessage(jid, { text: 'For security, send /pair in a private chat with this bot, not in a group.' }), sender);
      return;
    }
    if (isOwner) {
      await sendBotPayload(jid, activeSock => activeSock.sendMessage(jid, { text: 'This number is already the primary bot owner. It does not need a second linked-device pairing.' }), sender);
      return;
    }
    try {
      const result = await createLinkedPairing(sender, {
        onCodeRefresh: newCode => sendBotPayload(jid, s => s.sendMessage(jid, { text: `WhatsApp expired the previous code. Your new device-linking code is:\n\n\`\`\`${newCode}\`\`\`` }), sender)
      });
      if (result.code) {
        const reply = [
          '*WHATSAPP PROTECTION — DEVICE LINKING*',
          '',
          'Your genuine WhatsApp device-linking code is:',
          '',
          '```' + result.code + '```',
          '',
          'On the same phone number, open WhatsApp → Linked devices → Link a device → Link with phone number, then enter this code.',
          'Keep this code private. If WhatsApp expires it before you link, a new code is sent here automatically for up to 10 minutes.',
          '',
          'After the account connects, send /menu in your own "Message yourself" chat to use the bot.'
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
    await sendBrandedText(jid, 'COMMANDS', ['/pair', '/menu', '/developers', '/status', '/activate ban_protection', '/activate bug_protection', '/activate soam_protection', '/deactivate ban_protection', '/deactivate bug_protection', '/deactivate soam_protection'].join('\n'), [], phone);
    insertLog.run(phone, 'command_list_button', action); return;
  }
  if (command === 'wp_developers' || command === '/developers') {
    await sendBrandedText(jid, 'DEVELOPERS', 'Lord Voyage — +256 702 662 846\nhttps://wa.me/256702662846\n\nCalvin The Great — +256 766 808 269\nhttps://wa.me/256766808269', [
      { label: 'Lord Voyage', url: 'https://wa.me/256702662846' },
      { label: 'Calvin The Great', url: 'https://wa.me/256766808269' }
    ], phone);
    insertLog.run(phone, 'command_developers', action); return;
  }
  const match = command.match(/^\/activate (ban_protection|bug_protection|soam_protection)$/);
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
  const off = command.match(/^\/deactivate (ban_protection|bug_protection|soam_protection)$/);
  if (off) {
    const feature = off[1];
    // Send the confirmation before disabling so Ban Protection's own queue still applies to it.
    await sendBrandedText(jid, 'PROTECTION DEACTIVATED', `${feature} is now disabled for ${phone}. Send /activate ${feature} to turn it back on.`, [], phone);
    upsertProtection.run(phone, feature, 0);
    insertLog.run(phone, 'protection_deactivated', feature);
    return;
  }
  if (command === '/status') {
    const lines = PROTECTION_FEATURES.map(feature => `${feature}: ${featureEnabled(feature, phone) ? 'ON' : 'OFF'}`);
    const linked = getLinkedDevice.get(phone);
    lines.push('', `Account: ${isOwner ? 'primary owner' : `linked (${linked?.session_status || 'unknown'})`}`);
    await sendBrandedText(jid, 'PROTECTION STATUS', lines.join('\n'), [], phone);
    insertLog.run(phone, 'command_status', '/status');
    return;
  }
  const unknown = action.startsWith('/') ? action : '';
  if (unknown) {
    if (featureEnabled('soam_protection', phone)) securityEvent(sender, 'low', 'unknown_command', unknown.slice(0, 160), phone);
    await sendBrandedText(jid, 'UNKNOWN COMMAND', 'That command is not supported. Send /menu to see the available commands.', [], phone);
  }
}

function endPrimaryPairing(activeSock, status, reason) {
  clearTimeout(primaryPairingTimer); primaryPairingTimer = null;
  manualDisconnect = true;
  primaryPairingCode = null;
  try { activeSock?.end(new Error(reason)); } catch (_) {}
  if (sock === activeSock) sock = null;
  if (!isRegisteredCredsFile(path.join(AUTH_DIR, 'creds.json'))) clearPrimaryAuth();
  currentStatus = status;
  if (currentPhone) { try { setPair.run(currentPhone, status); insertPairEvent.run(currentPhone, 'primary_pairing_ended', reason); } catch (_) {} }
}

async function startSocket(phoneForPairing = null, requestCode = false) {
  if (sock || shuttingDown) throw new Error('A WhatsApp session is already active or starting.');
  manualDisconnect = false;
  currentStatus = 'connecting';
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  if (sock || shuttingDown) throw new Error('A WhatsApp session is already active or starting.');
  const version = await resolveWaVersion();
  if (sock || shuttingDown) throw new Error('A WhatsApp session is already active or starting.');
  const activeSock = makeWASocket(waSocketOptions(state, version));
  const pairingReady = requestCode && !state.creds.registered ? waitForPairingChallenge(activeSock) : null;
  sock = activeSock;
  if (phoneForPairing) currentPhone = phoneForPairing;
  activeSock.ev.on('creds.update', saveCreds);
  activeSock.ev.on('connection.update', async update => {
    try {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        clearTimeout(primaryPairingTimer); primaryPairingTimer = null;
        currentStatus = 'connected'; primaryPairingCode = null; reconnectAttempt = 0;
        const registeredPhone = phoneFromJid(activeSock.user?.id) || currentPhone;
        if (registeredPhone) { currentPhone = registeredPhone; setPair.run(registeredPhone, 'connected'); insertPairEvent.run(registeredPhone, 'connected', 'Baileys connection opened'); insertLog.run(registeredPhone, 'connection_open', 'WhatsApp connected'); }
        if (featureEnabled('bug_protection', registeredPhone)) insertSecurityEvent.run(registeredPhone, null, 'info', 'connection_recovered', 'WhatsApp connection opened successfully');
        log.info('WhatsApp connected');
        await followChannelForPrimaryAccount(registeredPhone, activeSock);
      }
      if (connection === 'close') {
        if (sock !== activeSock) return;
        sock = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        const canReconnect = state.creds.registered || code === DisconnectReason.restartRequired;
        if (currentPhone) { setPair.run(currentPhone, loggedOut ? 'logged_out' : 'disconnected'); insertPairEvent.run(currentPhone, 'disconnected', `Disconnect status ${code ?? 'unknown'}`); }
        if (featureEnabled('bug_protection')) insertSecurityEvent.run(currentPhone || null, null, 'warning', 'connection_closed', `Disconnect status ${code ?? 'unknown'}`);
        if (shuttingDown || manualDisconnect) { currentStatus = 'disconnected'; return; }
        if (loggedOut) {
          // The saved credentials are no longer valid; remove them so the owner can pair again.
          clearTimeout(primaryPairingTimer); primaryPairingTimer = null;
          primaryPairingCode = null;
          clearPrimaryAuth();
          currentStatus = 'logged_out';
          log.warn('Primary WhatsApp session was logged out; pair again from /pair');
          return;
        }
        if (!canReconnect) {
          if (requestCode && phoneForPairing && primaryPairingCode && pairingRefreshAllowed(primaryPairingDeadline)) {
            clearTimeout(primaryPairingTimer); primaryPairingTimer = null;
            primaryPairingCode = null;
            clearPrimaryAuth();
            currentStatus = 'pairing';
            insertPairEvent.run(phoneForPairing, 'primary_pairing_code_refreshing', `WhatsApp closed the unlinked pairing connection; status ${code ?? 'unknown'}`);
            startSocket(phoneForPairing, true).catch(error => safeLogError(error, 'Primary pairing code refresh failed'));
            return;
          }
          endPrimaryPairing(null, 'pairing_expired', `Pairing ended before the device was linked; status ${code ?? 'unknown'}`);
          return;
        }
        currentStatus = code === DisconnectReason.restartRequired ? 'connecting' : 'connection_lost';
        reconnectAttempt += 1;
        const base = code === DisconnectReason.restartRequired ? 1000 : Math.min(300_000, 3000 * (2 ** Math.min(reconnectAttempt - 1, 7)));
        const jitter = Math.floor(Math.random() * Math.min(5000, Math.max(500, base * 0.2)));
        const delay = Math.min(featureEnabled('bug_protection') ? 300_000 : 60_000, base + jitter);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => startSocket().catch(error => safeLogError(error, 'Reconnect attempt failed')), delay);
        log.warn({ attempt: reconnectAttempt, delay, statusCode: code }, 'Scheduling WhatsApp reconnect');
      }
    } catch (error) {
      safeLogError(error, 'Primary connection handler failed');
    }
  });
  activeSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages || []) {
      try { observeInboundActivity(msg); await handleCommand(msg, activeSock); } catch (error) { safeLogError(error, 'Command handler failed'); }
    }
  });
  if (requestCode && !state.creds.registered) {
    try {
      await pairingReady;
      if (sock !== activeSock) throw new Error('WhatsApp disconnected before the device-linking code was ready. Try again.');
      const code = await activeSock.requestPairingCode(phoneForPairing);
      if (sock !== activeSock) throw new Error('WhatsApp disconnected before the device-linking code was ready. Try again.');
      primaryPairingCode = code;
      currentStatus = 'pairing';
      clearTimeout(primaryPairingTimer);
      if (!primaryPairingDeadline || primaryPairingDeadline < Date.now()) primaryPairingDeadline = Date.now() + PAIRING_TOKEN_TTL;
      primaryPairingTimer = setTimeout(() => {
        if (sock === activeSock && currentStatus !== 'connected') endPrimaryPairing(activeSock, 'pairing_expired', 'Pairing code expired before the device was linked');
      }, Math.max(1000, primaryPairingDeadline - Date.now()));
      primaryPairingTimer.unref?.();
      setPair.run(phoneForPairing, 'pairing');
      insertPairEvent.run(phoneForPairing, 'primary_pairing_code_generated', 'Primary owner device-linking code generated');
      return code;
    } catch (error) {
      endPrimaryPairing(activeSock, 'connection_lost', `Pairing code request failed: ${String(error?.message || error).slice(0, 200)}`);
      throw error;
    }
  }
  if (!state.creds.registered && !requestCode) {
    endPrimaryPairing(activeSock, 'disconnected', 'Saved primary credentials were not registered');
    return null;
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
function rateLimit({ limit = 5, windowMs = 60_000 } = {}) {
  const limitBuckets = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown'; const now = Date.now();
    const recent = (limitBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (limitBuckets.size > 3000) { for (const [ip, stamps] of limitBuckets) if (!stamps.some(t => now - t < windowMs)) limitBuckets.delete(ip); }
    if (recent.length >= limit) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    recent.push(now); limitBuckets.set(key, recent); next();
  };
}
// Code requests are strictly limited; status polling (every 1.5 s until linked) gets its own budget.
const pairCodeRequestLimit = rateLimit({ limit: 5 });
const pairStatusLimit = rateLimit({ limit: 90 });
// Health reflects the web process and database only, so Render does not restart the service
// just because WhatsApp is disconnected or not yet paired.
app.get('/api/health', (_req, res) => {
  let database = false;
  try { database = db.prepare('SELECT 1 AS ok').get()?.ok === 1; } catch (error) { log.error({ err: error }, 'Database health check failed'); }
  res.status(database ? 200 : 503).json({ ok: database, service: 'whatsapp-protection', status: currentStatus, database });
});
app.get('/api/status', (_req, res) => res.json({ status: currentStatus, connected: currentStatus === 'connected' }));
// Website pairing. The primary bot account is paired first: either OWNER_NUMBER, or, when
// OWNER_NUMBER is unset, the first number submitted while no primary session exists. Every
// other number gets its own independent linked-device session (same as the /pair command).
// Codes always come from Baileys requestPairingCode; the short-lived pairingToken only lets
// the requesting browser poll for that one request's status.
const linkedPairingTokens = new Map();
function issueLinkedPairingToken(phone) {
  const now = Date.now();
  for (const [token, entry] of linkedPairingTokens) if (entry.expires < now) linkedPairingTokens.delete(token);
  const token = crypto.randomBytes(24).toString('hex');
  linkedPairingTokens.set(token, { phone, expires: now + PAIRING_TOKEN_TTL + 2 * 60_000 });
  return token;
}
function linkedPairingState(phone) {
  const record = linkedSessions.get(phone);
  if (record) {
    if (record.status === 'connected') return { code: null, status: 'connected', connected: true };
    if (record.status === 'pairing') return { code: record.code && record.codeExpiresAt > Date.now() ? record.code : null, status: 'pairing', connected: false };
    // connection_lost/connecting here is WhatsApp's normal restart right after the code is accepted.
    if (['connecting', 'connection_lost'].includes(record.status)) return { code: null, status: 'connecting', connected: false };
    if (record.status === 'revoked') return { code: null, status: 'logged_out', connected: false };
  }
  return getLinkedDevice.get(phone)?.status === 'active'
    ? { code: null, status: 'connecting', connected: false }
    : { code: null, status: 'pairing_expired', connected: false };
}
function isPrimaryPairingRequest(phone) {
  const configuredOwner = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');
  if (configuredOwner) return phone === configuredOwner;
  if (currentPhone && phone === currentPhone) return true;
  return !sock && currentStatus !== 'connected' && !isRegisteredCredsFile(path.join(AUTH_DIR, 'creds.json')) && getLinkedDevice.get(phone)?.status !== 'active';
}
let primaryPairingStarting = false;
let primaryPairingPhone = null;
async function requestPrimaryPairing(phone, res) {
  const expiresInSeconds = PAIRING_TOKEN_TTL / 1000;
  if (currentStatus === 'connected') return res.status(409).json({ error: 'This number is already connected as the primary bot account.' });
  if (primaryPairingStarting) return res.status(409).json({ error: 'The primary WhatsApp session is already connecting. Wait a moment and try again.' });
  if (sock) {
    if (primaryPairingPhone === phone && currentPhone === phone && primaryPairingToken && Date.now() < primaryPairingTokenExpires) return res.json({ status: currentStatus, pairingToken: primaryPairingToken, code: primaryPairingCode, expiresInSeconds });
    return res.status(409).json({ error: 'The primary WhatsApp session is already connecting. Wait a moment and try again.' });
  }
  if (isRegisteredCredsFile(path.join(AUTH_DIR, 'creds.json'))) return res.status(409).json({ error: 'The primary WhatsApp account is already registered. Restore its saved session or securely reset DATA_DIR/auth to pair again.' });
  primaryPairingStarting = true;
  let code;
  try {
    primaryPairingToken = crypto.randomBytes(24).toString('hex');
    primaryPairingPhone = phone;
    // The token outlives the code slightly so the page can still read the final status.
    primaryPairingTokenExpires = Date.now() + PAIRING_TOKEN_TTL + 2 * 60_000;
    primaryPairingCode = null;
    primaryPairingDeadline = Date.now() + PAIRING_TOKEN_TTL;
    code = await startSocket(phone, true);
  } finally { primaryPairingStarting = false; }
  if (!code) return res.status(202).json({ status: currentStatus, pairingToken: primaryPairingToken, expiresInSeconds, message: 'Pairing started. Waiting for the code…' });
  res.json({ status: currentStatus, pairingToken: primaryPairingToken, code, expiresInSeconds });
}
app.post('/api/pair-code', pairCodeRequestLimit, async (req, res) => {
  let phone = '';
  try {
    phone = normalizePhone(req.body?.phone);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    if (isPrimaryPairingRequest(phone)) return await requestPrimaryPairing(phone, res);
    const result = await createLinkedPairing(phone);
    if (!result.code) {
      const connected = result.status === 'connected';
      return res.json({ status: result.status || 'connected', connected, message: result.message, ...(connected ? {} : { pairingToken: issueLinkedPairingToken(phone) }) });
    }
    res.json({ status: 'pairing', pairingToken: issueLinkedPairingToken(phone), code: result.code, expiresInSeconds: PAIRING_TOKEN_TTL / 1000 });
  } catch (error) {
    safeLogError(error, 'Website pairing request failed', phone);
    res.status(502).json({ error: error.message || 'Could not generate a device-linking code.' });
  }
});
app.get('/api/pair-code/status', pairStatusLimit, (req, res) => {
  const token = String(req.query.token || '');
  res.set('Cache-Control', 'no-store');
  const linked = token && linkedPairingTokens.get(token);
  if (linked && Date.now() <= linked.expires) return res.json(linkedPairingState(linked.phone));
  if (!token || token !== primaryPairingToken || Date.now() > primaryPairingTokenExpires) return res.status(403).json({ error: 'Invalid or expired pairing request token.' });
  res.json({ code: primaryPairingCode, status: currentStatus, connected: currentStatus === 'connected' });
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/pair', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'pair.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('*', (req, res) => {
  // Missing files (e.g. /assets/missing.js) must 404 instead of returning HTML with a 200.
  if (path.extname(req.path)) return res.status(404).type('text/plain').send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((error, _req, res, _next) => {
  const status = error.status || error.statusCode || 500;
  if (status >= 500) log.error({ err: error }, 'Unhandled request error');
  res.status(status).json({ error: status === 400 ? 'Invalid request body.' : status === 413 ? 'Request body too large.' : 'Internal server error.' });
});

async function bootExistingSession() {
  const credsFile = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(credsFile)) return;
  if (!isRegisteredCredsFile(credsFile)) {
    // Leftover credentials from an abandoned pairing attempt cannot connect; remove them.
    clearPrimaryAuth();
    return;
  }
  try { await startSocket(); } catch (error) { safeLogError(error, 'Could not restore existing WhatsApp session'); }
}
async function bootLinkedSessions() {
  // Pending pairings cannot survive a restart (the code was tied to the old socket).
  for (const row of db.prepare("SELECT phone FROM linked_devices WHERE status='pending'").all()) {
    const authPath = path.join(LINKED_AUTH_DIR, row.phone);
    if (!isRegisteredCredsFile(path.join(authPath, 'creds.json'))) fs.rmSync(authPath, { recursive: true, force: true });
    deletePendingLinkedDevice.run(row.phone);
  }
  const rows = db.prepare("SELECT phone FROM linked_devices WHERE status='active'").all();
  for (const row of rows) {
    try { await startLinkedSession(row.phone); }
    catch (error) { safeLogError(error, 'Could not restore linked device session', row.phone); }
  }
}

let server = null;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; if (reconnectTimer) clearTimeout(reconnectTimer); clearTimeout(primaryPairingTimer); clearInterval(retentionTimer);
  try { sock?.end(new Error('Server shutting down')); } catch (_) {}
  for (const record of linkedSessions.values()) {
    record.intentionalClose = true;
    clearTimeout(record.reconnectTimer); clearTimeout(record.expiryTimer);
    try { record.socket?.end(new Error('Server shutting down')); } catch (_) {}
  }
  const closeDb = () => { try { db.close(); } catch (_) {} process.exit(0); };
  if (server) server.close(closeDb); else closeDb();
  setTimeout(() => process.exit(1), 8000).unref();
}

function start() {
  process.on('unhandledRejection', error => safeLogError(error, 'Unhandled promise rejection'));
  process.on('uncaughtException', error => { safeLogError(error, 'Uncaught exception'); process.exit(1); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server = app.listen(PORT, '0.0.0.0', () => log.info(`WhatsApp Protection listening on ${PORT}`));
  bootExistingSession();
  bootLinkedSessions();
}

const isMainModule = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) start();

// Internal hooks used by the automated test suite (test/). Not part of the public HTTP API.
export const testing = {
  app, db, handleCommand, waitForPairingChallenge, pairingRefreshAllowed, replyContext, waSocketOptions, PAIRING_QR_REF_MS, linkedSessions, linkedPairingState, issueLinkedPairingToken, isPrimaryPairingRequest, resolveCommandSender, followChannelForPrimaryAccount, followChannelForLinkedAccount, featureEnabled,
  setPrimarySocket(activeSock, status = 'connected') { sock = activeSock; currentStatus = status; if (activeSock?.user?.id) currentPhone = phoneFromJid(activeSock.user.id); },
  CHANNEL_CODE
};
