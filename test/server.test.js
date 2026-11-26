import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNER = '256700000001';
const LINKED = '256700000002';
const STRANGER = '256700000003';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-test-'));
process.env.DATA_DIR = dataDir;
process.env.OWNER_NUMBER = OWNER;
process.env.LOG_LEVEL = 'silent';

const { testing } = await import('../server.js');
const { app, db, handleCommand, followChannelForPrimaryAccount, followChannelForLinkedAccount, featureEnabled, setPrimarySocket } = testing;
let server; let base;

function fakeSocket({ followError } = {}) {
  const calls = { sent: [], relayed: [], metadata: 0, follow: 0 };
  return {
    calls,
    user: { id: `${OWNER}:7@s.whatsapp.net`, lid: '99887766:7@lid' },
    authState: { creds: { me: { id: `${OWNER}:7@s.whatsapp.net` } } },
    sendMessage: async (jid, content) => { calls.sent.push({ jid, content }); return { key: { id: 'x' } }; },
    relayMessage: async (jid, message, opts) => { calls.relayed.push({ jid, message, opts }); },
    newsletterMetadata: async (type, key) => { calls.metadata += 1; assert.equal(type, 'invite'); assert.equal(key, testing.CHANNEL_CODE); return { id: '120363000000000000@newsletter' }; },
    newsletterFollow: async () => { calls.follow += 1; if (followError) throw followError; return { ok: true }; }
  };
}
const dm = (from, text, extra = {}) => ({ key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id: String(Math.random()), ...extra }, message: { conversation: text } });
const selfChat = text => ({ key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: true, id: String(Math.random()) }, message: { conversation: text } });
const lastText = sock => { const m = sock.calls.sent.at(-1); return m?.content?.text || ''; };

before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); try { db.close(); } catch (_) {} fs.rmSync(dataDir, { recursive: true, force: true }); });

test('database schema is initialized under DATA_DIR', () => {
  assert.ok(fs.existsSync(path.join(dataDir, 'whatsapp-protection.sqlite')));
  assert.ok(fs.existsSync(path.join(dataDir, 'auth', 'linked')));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['linked_devices', 'protection_settings', 'system_config', 'security_events', 'pairing_history']) assert.ok(tables.includes(t), t);
});

test('GET /api/health reports ok with a working database', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true); assert.equal(body.database, true);
});

test('HTTP routing: pages, missing assets and unknown API routes', async () => {
  for (const page of ['/', '/pair', '/dashboard', '/privacy', '/docs/commands.html', '/assets/app.js', '/assets/style.css']) {
    assert.equal((await fetch(base + page)).status, 200, page);
  }
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  const api = await fetch(`${base}/api/nope`);
  assert.equal(api.status, 404); assert.match(api.headers.get('content-type'), /json/);
  const csp = (await fetch(base)).headers.get('content-security-policy');
  assert.match(csp, /fonts\.googleapis\.com/); assert.match(csp, /fonts\.gstatic\.com/);
});

test('POST /api/pair-code only accepts the configured owner and rejects bad input', async () => {
  const other = await fetch(`${base}/api/pair-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: STRANGER }) });
  assert.equal(other.status, 403);
  const bad = await fetch(`${base}/api/pair-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400); assert.ok((await bad.json()).error);
  const status = await fetch(`${base}/api/pair-code/status?token=wrong`);
  assert.equal(status.status, 403);
});

test('primary channel follow stores state, avoids duplicates and survives failures', async () => {
  const failing = fakeSocket({ followError: new Error('GraphQL server error') });
  assert.equal(await followChannelForPrimaryAccount(OWNER, failing), false);
  assert.equal(db.prepare("SELECT value FROM system_config WHERE key='primary_channel_followed'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM pairing_history WHERE phone=? AND event='channel_follow_failed'").get(OWNER));

  const ok = fakeSocket();
  assert.equal(await followChannelForPrimaryAccount(OWNER, ok), true);
  assert.equal(ok.calls.follow, 1);
  assert.equal(db.prepare("SELECT value FROM system_config WHERE key='primary_channel_followed'").get().value, OWNER);
  assert.equal(await followChannelForPrimaryAccount(OWNER, ok), true);
  assert.equal(ok.calls.follow, 1, 'no duplicate follow once WhatsApp confirmed');

  assert.equal(await followChannelForPrimaryAccount(OWNER, {}), true, 'already-followed short-circuits before touching the socket');
  assert.equal(await followChannelForPrimaryAccount('256711111111', {}), false, 'missing follow methods fail safely');
});

test('linked channel follow marks only that account', async () => {
  db.prepare("INSERT INTO linked_devices(phone,status,session_status) VALUES(?,?,?)").run(LINKED, 'active', 'connected');
  const ok = fakeSocket();
  assert.equal(await followChannelForLinkedAccount(LINKED, ok), true);
  assert.equal(db.prepare('SELECT channel_followed FROM linked_devices WHERE phone=?').get(LINKED).channel_followed, 1);
  await followChannelForLinkedAccount(LINKED, ok);
  assert.equal(ok.calls.follow, 1);
});

test('owner commands from the self chat update only the owner settings', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  await handleCommand(selfChat('/activate   ban_protection'), sock);
  assert.equal(featureEnabled('ban_protection', OWNER), true);
  assert.equal(featureEnabled('ban_protection', LINKED), false);
  assert.match(lastText(sock), /PROTECTION ACTIVATED/);
  await handleCommand(selfChat('/status'), sock);
  assert.match(lastText(sock), /ban_protection: ON/);
  await handleCommand(selfChat('/deactivate ban_protection'), sock);
  assert.equal(featureEnabled('ban_protection', OWNER), false);
});

test('outgoing messages to other chats are never treated as owner commands', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  await handleCommand({ key: { remoteJid: `${STRANGER}@s.whatsapp.net`, fromMe: true, id: 'a' }, message: { conversation: '/activate bug_protection' } }, sock);
  assert.equal(featureEnabled('bug_protection', OWNER), false);
  assert.equal(sock.calls.sent.length, 0);
});

test('linked numbers manage their own settings; strangers are rejected and logged', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  await handleCommand(dm(LINKED, '/activate soam_protection'), sock);
  assert.equal(featureEnabled('soam_protection', LINKED), true);
  assert.equal(featureEnabled('soam_protection', OWNER), false);

  const before = sock.calls.sent.length;
  await handleCommand(dm(STRANGER, '/activate bug_protection'), sock);
  assert.equal(featureEnabled('bug_protection', STRANGER), false);
  assert.equal(sock.calls.sent.length, before, 'no reply to unauthorized command');
  assert.ok(db.prepare("SELECT 1 FROM security_events WHERE sender=? AND event='unauthorized_command_attempt'").get(STRANGER));
});

test('LID-only senders are not treated as phone numbers', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  await handleCommand({ key: { remoteJid: `${LINKED}@lid`, fromMe: false, id: 'l' }, message: { conversation: '/activate bug_protection' } }, sock);
  assert.equal(featureEnabled('bug_protection', LINKED), false);
  await handleCommand({ key: { remoteJid: '55555555@lid', fromMe: false, id: 'l2' }, message: { conversation: '/pair' } }, sock);
  assert.match(lastText(sock), /could not be verified/);
  await handleCommand({ key: { remoteJid: '55555555@lid', remoteJidAlt: `${LINKED}@s.whatsapp.net`, fromMe: false, id: 'l3' }, message: { conversation: '/activate bug_protection' } }, sock);
  assert.equal(featureEnabled('bug_protection', LINKED), true, 'remoteJidAlt phone number is used when present');
});

test('/pair is refused in groups and for the owner', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  await handleCommand({ key: { remoteJid: '1203630000@g.us', participant: `${STRANGER}@s.whatsapp.net`, fromMe: false, id: 'g' }, message: { conversation: '/pair' } }, sock);
  assert.match(lastText(sock), /private chat/);
  await handleCommand(selfChat('/pair'), sock);
  assert.match(lastText(sock), /already the primary bot owner/);
});

test('SOAM cooldown blocks command floods without crashing', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  for (let i = 0; i < 10; i += 1) await handleCommand(dm(LINKED, '/status'), sock);
  assert.ok(db.prepare("SELECT 1 FROM security_events WHERE sender=? AND event='command_abuse_cooldown'").get(LINKED));
});

test('interactive buttons are sent through baileys_helper with plain-text fallback', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  await handleCommand(selfChat('/developers'), sock);
  assert.equal(sock.calls.relayed.length, 1);
  assert.ok(sock.calls.relayed[0].message.interactiveMessage || sock.calls.relayed[0].message.viewOnceMessage);
  const broken = fakeSocket(); broken.relayMessage = async () => { throw new Error('relay failed'); }; setPrimarySocket(broken);
  await handleCommand(selfChat('/developers'), broken);
  assert.match(lastText(broken), /wa\.me\/256702662846/);
});

test('pairing codes are requested only after WhatsApp offers a pairing challenge', async () => {
  const { EventEmitter } = await import('node:events');
  const ev = new EventEmitter();
  const ready = testing.waitForPairingChallenge({ ev }, 1000);
  ev.emit('connection.update', { connection: 'connecting' });
  ev.emit('connection.update', { qr: 'challenge' });
  await ready;
  assert.equal(ev.listenerCount('connection.update'), 0);
  const closed = testing.waitForPairingChallenge({ ev }, 1000);
  ev.emit('connection.update', { connection: 'close' });
  await assert.rejects(closed, /closed the connection/);
  await assert.rejects(testing.waitForPairingChallenge({ ev }, 20), /Timed out/);
});

test('pairing status polling is not throttled by the code-request limit', async () => {
  for (let i = 0; i < 12; i += 1) assert.equal((await fetch(`${base}/api/pair-code/status?token=wrong`)).status, 403);
  let limited = false;
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(`${base}/api/pair-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: STRANGER }) });
    if (res.status === 429) limited = true;
  }
  assert.ok(limited, 'code requests are still rate limited');
});
