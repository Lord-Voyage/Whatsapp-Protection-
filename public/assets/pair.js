const year = document.getElementById('year');
if (year) year.textContent = new Date().getFullYear();
const menuButton = document.querySelector('.menu-toggle');
menuButton?.addEventListener('click', () => { const open = document.body.classList.toggle('menu-open'); menuButton.setAttribute('aria-expanded', String(open)); });
const form = document.getElementById('pairForm');
const button = document.getElementById('pairButton');
const statusNode = document.getElementById('pairStatus');
const codeWrap = document.getElementById('pairCodeWrap');
const codeNode = document.getElementById('pairCode');
const copyButton = document.getElementById('copyPairCode');
const FAILED_STATES = { pairing_expired: 'The pairing code expired before the device was linked. Request a new code.', connection_lost: 'The WhatsApp connection was lost before pairing completed. Try again.', logged_out: 'WhatsApp rejected the session. Request a new code.', disconnected: 'Pairing was cancelled. Request a new code.' };
let activeCode = '';
let pollTimer = null;
let pairingToken = '';
function status(message, error = false) {
  statusNode.textContent = message;
  statusNode.dataset.state = error ? 'error' : 'info';
}
function resetButton(label = 'Generate Pairing Code ↗') { button.disabled = false; button.textContent = label; }
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
function showCode(code) {
  if (activeCode === code) return;
  activeCode = code;
  codeNode.textContent = code;
  codeWrap.hidden = false;
  status('Pairing code ready. Enter it in WhatsApp Linked devices. Waiting for WhatsApp to confirm…');
  resetButton();
}
async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}
function startPolling() {
  let attempts = 0;
  stopPolling();
  pollTimer = setInterval(async () => {
    attempts += 1;
    try {
      const result = await fetch(`/api/pair-code/status?token=${encodeURIComponent(pairingToken)}`, { cache: 'no-store' });
      const current = await readJson(result);
      if (!result.ok) throw new Error(current.error || 'Could not check pairing status.');
      if (current.connected || current.status === 'connected') { stopPolling(); codeWrap.hidden = true; activeCode = ''; status('WhatsApp connected successfully. Send /menu in your WhatsApp “Message yourself” chat to use the bot.'); resetButton(); return; }
      if (current.code) showCode(current.code);
      if (FAILED_STATES[current.status] || attempts >= 480) { stopPolling(); codeWrap.hidden = true; activeCode = ''; status(FAILED_STATES[current.status] || 'Pairing did not complete. Check the service logs and try again.', true); resetButton('Try again ↗'); }
    } catch (error) { stopPolling(); status(error.message, true); resetButton('Try again ↗'); }
  }, 1500);
}
form?.addEventListener('submit', async event => {
  event.preventDefault();
  stopPolling();
  activeCode = ''; pairingToken = ''; codeWrap.hidden = true;
  const phone = document.getElementById('phone').value.replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) return status('Enter a valid international phone number including its country code.', true);
  button.disabled = true; button.textContent = 'Requesting code…'; status('Contacting the persistent WhatsApp pairing service…');
  try {
    const response = await fetch('/api/pair-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }) });
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error || 'Pairing request failed.');
    pairingToken = data.pairingToken || '';
    if (data.connected) { status(data.message || 'This WhatsApp number is already connected.'); resetButton(); return; }
    if (data.code) showCode(data.code);
    else status(data.message || 'Pairing started. Waiting for Baileys to return the code…');
    startPolling();
  } catch (error) { status(error.message, true); resetButton('Try again ↗'); }
});
copyButton?.addEventListener('click', async () => {
  if (!activeCode) return;
  try { await navigator.clipboard.writeText(activeCode); copyButton.textContent = 'Copied!'; setTimeout(() => { copyButton.textContent = 'Copy code'; }, 1800); }
  catch { status('Clipboard access was blocked. Select the code and copy it manually.', true); }
});
