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

function fakeSocket({ followError, user = { id: `${OWNER}:7@s.whatsapp.net`, lid: '99887766:7@lid' } } = {}) {
  const calls = { sent: [], relayed: [], all: [], follow: 0, followed: [] };
  return {
    calls,
    user,
    authState: { creds: { me: { id: user.id } } },
    sendMessage: async (jid, content) => { const entry = { jid, content }; calls.sent.push(entry); calls.all.push(entry); return { key: { id: 'x' } }; },
    relayMessage: async (jid, message, opts) => { const entry = { jid, message, opts }; calls.relayed.push(entry); calls.all.push(entry); },
    waUploadToServer: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/test', directPath: '/test' }),
    newsletterFollow: async jid => { calls.follow += 1; calls.followed.push(jid); if (followError) throw followError; return { ok: true }; }
  };
}
const interactiveOf = entry => entry?.message?.interactiveMessage || entry?.message?.viewOnceMessage?.message?.interactiveMessage || null;
const dm = (from, text, extra = {}) => ({ key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id: String(Math.random()), ...extra }, message: { conversation: text } });
const selfChat = text => ({ key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: true, id: String(Math.random()) }, message: { conversation: text } });
const lastText = sock => { const m = sock.calls.all.at(-1); return m?.content?.text || m?.content?.caption || interactiveOf(m)?.body?.text || ''; };

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

test('POST /api/pair-code validates input and refuses to re-pair a connected primary', async () => {
  const post = body => fetch(`${base}/api/pair-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const bad = await post('{oops');
  assert.equal(bad.status, 400); assert.ok((await bad.json()).error);
  const short = await post(JSON.stringify({ phone: '123' }));
  assert.equal(short.status, 400); assert.match((await short.json()).error, /valid international phone number/);
  setPrimarySocket(fakeSocket());
  const owner = await post(JSON.stringify({ phone: `+${OWNER}` }));
  assert.equal(owner.status, 409);
  assert.doesNotMatch((await owner.json()).error, /OWNER_NUMBER/);
  assert.equal((await fetch(`${base}/api/pair-code/status?token=wrong`)).status, 403);
});

test('website pairing routes the owner to the primary session and everyone else to linked sessions', () => {
  assert.equal(testing.isPrimaryPairingRequest(OWNER), true);
  assert.equal(testing.isPrimaryPairingRequest(STRANGER), false);
  const saved = process.env.OWNER_NUMBER;
  try {
    delete process.env.OWNER_NUMBER;
    assert.equal(testing.isPrimaryPairingRequest(OWNER), true, 'the connected primary number stays primary');
    assert.equal(testing.isPrimaryPairingRequest(STRANGER), false, 'a primary session already exists, so others get linked sessions');
  } finally { process.env.OWNER_NUMBER = saved; }
});

test('linked pairing status is readable only with its token and follows the session lifecycle', async () => {
  const phone = '256700000077';
  const token = testing.issueLinkedPairingToken(phone);
  const status = async () => (await fetch(`${base}/api/pair-code/status?token=${token}`)).json();
  assert.equal((await status()).status, 'pairing_expired');
  const record = { status: 'pairing', code: 'ABCD1234', codeExpiresAt: Date.now() + 60_000 };
  testing.linkedSessions.set(phone, record);
  assert.deepEqual(await status(), { code: 'ABCD1234', status: 'pairing', connected: false });
  record.status = 'connection_lost'; record.code = null;
  assert.equal((await status()).status, 'connecting', 'post-pairing restart is not reported as a failure');
  record.status = 'connected';
  assert.deepEqual(await status(), { code: null, status: 'connected', connected: true });
  testing.linkedSessions.delete(phone);
  assert.equal((await fetch(`${base}/api/pair-code/status?token=other`)).status, 403);
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

test('owners run commands in any chat or group and the reply goes to that chat', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  const other = `${STRANGER}@s.whatsapp.net`;
  await handleCommand({ key: { remoteJid: other, fromMe: true, id: 'a' }, message: { conversation: '/status' } }, sock);
  assert.equal(sock.calls.all.at(-1).jid, other);
  assert.match(lastText(sock), /PROTECTION STATUS[\s\S]*primary owner/);
  const group = '1203630000@g.us';
  await handleCommand({ key: { remoteJid: group, participant: `${OWNER}@s.whatsapp.net`, fromMe: true, id: 'g1' }, message: { conversation: '/menu' } }, sock);
  assert.equal(sock.calls.all.at(-1).jid, group);
  const before = sock.calls.all.length;
  await handleCommand({ key: { remoteJid: other, fromMe: true, id: 'b' }, message: { conversation: 'hello' } }, sock);
  await handleCommand({ key: { remoteJid: other, fromMe: true, id: 'c' }, message: { conversation: '/shrug' } }, sock);
  assert.equal(sock.calls.all.length, before, 'ordinary text and unknown slash text in other chats get no reply');
  await handleCommand({ key: { remoteJid: group, participant: `${STRANGER}@s.whatsapp.net`, fromMe: false, id: 'g2' }, message: { conversation: '/activate bug_protection' } }, sock);
  assert.equal(featureEnabled('bug_protection', STRANGER), false);
  assert.equal(sock.calls.all.length, before, 'unpaired group members get no reply');
});

test('linked numbers manage their own settings; strangers are rejected and logged', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  await handleCommand(dm(LINKED, '/activate soam_protection'), sock);
  assert.equal(featureEnabled('soam_protection', LINKED), true);
  assert.equal(featureEnabled('soam_protection', OWNER), false);

  const before = sock.calls.all.length;
  await handleCommand(dm(STRANGER, '/activate bug_protection'), sock);
  assert.equal(featureEnabled('bug_protection', STRANGER), false);
  assert.equal(sock.calls.all.length, before + 1, 'unpaired users are told how to pair');
  assert.match(lastText(sock), /not paired[\s\S]*\/pair/);
  await handleCommand(dm(STRANGER, '/menu'), sock);
  assert.equal(sock.calls.all.length, before + 1, 'the notice is rate limited');
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

test('linked users with a LID Baileys id can run every command through their own session', async () => {
  const USER = '256700000078';
  db.prepare("INSERT INTO linked_devices(phone,status,session_status) VALUES(?,?,?)").run(USER, 'active', 'connected');
  const linkedSock = fakeSocket({ user: { id: 'opaque-user:3@lid', phoneNumber: `${USER}@s.whatsapp.net`, lid: 'opaque-user:3@lid' } });
  testing.setPrimarySocket(linkedSock);
  testing.linkedSessions.set(USER, { status: 'connected', socket: linkedSock });
  const self = command => ({ key: { remoteJid: `${USER}@s.whatsapp.net`, fromMe: true, id: `linked-${command}` }, message: { conversation: command } });
  try {
    for (const command of [
      '/pair', '/menu', '/developers', '/status',
      '/activate ban_protection', '/activate bug_protection', '/activate soam_protection',
      '/deactivate ban_protection', '/deactivate bug_protection', '/deactivate soam_protection'
    ]) {
      const before = linkedSock.calls.all.length;
      await testing.replyContext.run({ socket: linkedSock, isOpen: () => true }, () => handleCommand(self(command), linkedSock));
      assert.equal(linkedSock.calls.all.length, before + 1, `${command} sends a response`);
      assert.notEqual(lastText(linkedSock), '', `${command} has a readable response`);
    }
    assert.equal(featureEnabled('ban_protection', USER), false);
    assert.equal(featureEnabled('bug_protection', USER), false);
    assert.equal(featureEnabled('soam_protection', USER), false);
  } finally {
    testing.linkedSessions.delete(USER);
  }
});

test('/pair is refused in groups and for the owner', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  await handleCommand({ key: { remoteJid: '1203630000@g.us', participant: `${STRANGER}@s.whatsapp.net`, fromMe: false, id: 'g' }, message: { conversation: '/pair' } }, sock);
  assert.match(lastText(sock), /private chat/);
  await handleCommand(selfChat('/pair'), sock);
  const ownerNotice = interactiveOf(sock.calls.all.at(-1))?.body?.text || '';
  assert.match(ownerNotice, /\*This number is already the primary bot owner\.\*/);
  assert.match(ownerNotice, /\*It does not need a second linked-device pairing\.\*/);
});

test('SOAM cooldown blocks command floods without crashing', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  for (let i = 0; i < 10; i += 1) await handleCommand(dm(LINKED, '/status'), sock);
  assert.ok(db.prepare("SELECT 1 FROM security_events WHERE sender=? AND event='command_abuse_cooldown'").get(LINKED));
});

test('menu and every command reply carry buttons and the channel banner; the menu lists every documented command', async () => {
  const sock = fakeSocket(); setPrimarySocket(sock);
  await handleCommand(selfChat('/menu'), sock);
  const menu = interactiveOf(sock.calls.all.at(-1));
  assert.ok(menu, 'menu is a button message');
  assert.ok(menu.header?.imageMessage, 'menu keeps the logo image');
  assert.equal(menu.nativeFlowMessage.buttons.length, 3, 'the menu stays within WhatsApp native-flow button limits');
  assert.equal(menu.contextInfo.forwardedNewsletterMessageInfo.newsletterJid, '120363409908822540@newsletter');
  assert.equal(menu.contextInfo.isForwarded, true);
  const menuButtons = menu.nativeFlowMessage.buttons.map(b => JSON.parse(b.buttonParamsJson));
  assert.ok(menuButtons.some(b => b.url === testing.CHANNEL_URL), 'menu has the channel button');
  const commandPicker = menu.nativeFlowMessage.buttons.find(b => b.name === 'single_select');
  assert.ok(commandPicker, 'menu includes a native command picker');
  const rows = JSON.parse(commandPicker.buttonParamsJson).sections.flatMap(section => section.rows);
  const html = fs.readFileSync(new URL('../public/docs/commands.html', import.meta.url), 'utf8');
  const documented = [...html.matchAll(/<code>(\/[a-z_ ]+)<\/code>/g)].map(m => m[1].trim());
  assert.ok(documented.length >= 10);
  for (const command of documented) assert.ok(menu.body.text.includes(command), `menu lists ${command}`);
  for (const command of documented.filter(command => command !== '/pair')) {
    assert.ok(rows.some(row => row.id === command && row.description === command), `picker includes ${command}`);
  }
  for (const command of documented.filter(c => c !== '/pair')) {
    const count = sock.calls.all.length;
    await handleCommand(selfChat(command), sock);
    assert.equal(sock.calls.all.length, count + 1, `${command} replies`);
    const reply = interactiveOf(sock.calls.all.at(-1));
    assert.equal(reply?.nativeFlowMessage?.buttons?.length, 3, `${command} reply has at most three visible buttons`);
    assert.ok(reply.nativeFlowMessage.buttons.some(button => JSON.parse(button.buttonParamsJson).url === testing.CHANNEL_URL), `${command} reply retains the channel CTA`);
    assert.equal(reply.contextInfo.forwardedNewsletterMessageInfo.newsletterJid, testing.CHANNEL_JID);
    assert.doesNotMatch(lastText(sock), /UNKNOWN COMMAND/, `${command} is handled`);
  }
  const statusRow = rows.find(row => row.id === '/status');
  const count = sock.calls.all.length;
  await handleCommand({
    key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: true, id: 'btn' },
    message: {
      ephemeralMessage: {
        message: {
          viewOnceMessage: {
            message: {
              interactiveResponseMessage: {
                nativeFlowResponseMessage: { paramsJson: JSON.stringify({ selected_row_id: statusRow.id }) }
              }
            }
          }
        }
      }
    }
  }, sock);
  assert.equal(sock.calls.all.length, count + 1);
  assert.match(lastText(sock), /PROTECTION STATUS/, 'tapping a button runs its command');
});

test('INTERACTIVE_BUTTONS=false sends standard messages that still carry the channel banner', async () => {
  process.env.INTERACTIVE_BUTTONS = 'false';
  try {
    const sock = fakeSocket(); setPrimarySocket(sock);
    await handleCommand(selfChat('/menu'), sock);
    const menu = sock.calls.all.at(-1).content;
    assert.ok(Buffer.isBuffer(menu.image));
    assert.match(menu.caption, /\/deactivate soam_protection[\s\S]*whatsapp\.com\/channel/);
    assert.equal(menu.contextInfo.forwardedNewsletterMessageInfo.newsletterJid, testing.CHANNEL_JID);
    assert.equal(menu.contextInfo.externalAdReply.sourceUrl, testing.CHANNEL_URL);
    await handleCommand(selfChat('/developers'), sock);
    assert.match(lastText(sock), /wa\.me\/256702662846/);
    assert.equal(sock.calls.relayed.length, 0);
  } finally { delete process.env.INTERACTIVE_BUTTONS; }
});

test('button messages are sent through baileys_helper with a standard fallback', async () => {
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
    const res = await fetch(`${base}/api/pair-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '1' }) });
    if (res.status === 429) limited = true;
  }
  assert.ok(limited, 'code requests are still rate limited');
});

test('linked users command the bot from their own account and get replies on their own session', async () => {
  const USER = '256700000044';
  db.prepare("INSERT INTO linked_devices(phone,status,session_status) VALUES(?,?,?)").run(USER, 'active', 'connected');
  const primary = fakeSocket(); setPrimarySocket(primary);
  const linkedSock = fakeSocket({ user: { id: `${USER}:3@s.whatsapp.net`, lid: '11223344:3@lid' } });
  const ctx = { socket: linkedSock, isOpen: () => true };
  const own = { key: { remoteJid: `${USER}@s.whatsapp.net`, fromMe: true, id: 'own1' }, message: { conversation: '/status' } };
  await testing.replyContext.run(ctx, () => testing.handleCommand(own, linkedSock));
  assert.match(lastText(linkedSock), /PROTECTION STATUS[\s\S]*linked/);
  assert.equal(primary.calls.all.length, 0, 'the reply is not sent from the primary bot');
  const before = linkedSock.calls.all.length;
  ctx.isOpen = () => false;
  await testing.replyContext.run(ctx, () => testing.handleCommand({ ...own, key: { ...own.key, id: 'own2' } }, linkedSock));
  assert.equal(linkedSock.calls.all.length, before, 'nothing is sent through a closed linked session');
});

test('sessions use a standard browser identity and stay open for the whole pairing window', () => {
  const opts = testing.waSocketOptions({}, [2, 3000, 1]);
  assert.deepEqual(opts.browser, ['Mac OS', 'Chrome', '14.4.1']);
  assert.ok(testing.PAIRING_QR_REF_MS * 5 >= 10 * 60_000, 'Baileys pairing refs must cover the 10-minute code lifetime');
  assert.deepEqual(opts.version, [2, 3000, 1]);
});

test('pairing codes are refreshed only before the pairing deadline', () => {
  const now = Date.now();
  assert.equal(testing.pairingRefreshAllowed(now + 5 * 60_000, now), true);
  assert.equal(testing.pairingRefreshAllowed(now + 10_000, now), false, 'no refresh right before the deadline');
  assert.equal(testing.pairingRefreshAllowed(0, now), false);
});
