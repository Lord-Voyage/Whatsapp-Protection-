const year = document.getElementById('year');
if (year) year.textContent = new Date().getFullYear();
const menuButton = document.querySelector('.menu-toggle');
menuButton?.addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open');
  menuButton.setAttribute('aria-expanded', String(open));
});
const form = document.getElementById('pairForm');
const pairButton = document.getElementById('pairButton');
const pairStatus = document.getElementById('pairStatus');
const pairCodeWrap = document.getElementById('pairCodeWrap');
const pairCode = document.getElementById('pairCode');
const copyButton = document.getElementById('copyPairCode');
let statusPoll = null;
let currentCode = '';
function showStatus(message, isError = false) {
  if (!pairStatus) return;
  pairStatus.textContent = message;
  pairStatus.dataset.state = isError ? 'error' : 'info';
}
const FAILED_STATES = { pairing_expired: 'The pairing code expired before the device was linked. Request a new code.', connection_lost: 'The WhatsApp connection was lost before pairing completed. Try again.', logged_out: 'WhatsApp rejected the session. Request a new code.', disconnected: 'Pairing was cancelled. Request a new code.' };
function resetPairButton(label = 'Generate Pairing Code ↗') { pairButton.disabled = false; pairButton.textContent = label; }
function showPairCode(code) {
  if (currentCode === code) return;
  const refreshed = Boolean(currentCode);
  currentCode = code; pairCode.textContent = code; pairCodeWrap.hidden = false;
  showStatus(refreshed ? 'WhatsApp expired the previous code, so a new one was issued. Enter this new code in WhatsApp.' : 'Pairing code generated. Enter it in WhatsApp Linked devices. Waiting for WhatsApp to confirm…');
  resetPairButton();
}
async function readJson(response) { try { return await response.json(); } catch { return {}; } }
form?.addEventListener('submit', async event => {
  event.preventDefault();
  if (statusPoll) clearInterval(statusPoll);
  currentCode = '';
  pairCodeWrap.hidden = true;
  const phone = document.getElementById('phone').value.replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) return showStatus('Enter a valid international phone number including its country code.', true);
  pairButton.disabled = true; pairButton.textContent = 'Requesting code…';
  showStatus('Contacting the WhatsApp pairing service…');
  try {
    const response = await fetch('/api/pair-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }) });
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error || 'Pairing request failed.');
    if (data.connected) { showStatus(data.message || 'This WhatsApp number is already connected.'); resetPairButton(); return; }
    if (data.code) showPairCode(data.code);
    else showStatus(data.message || 'Pairing request started. Waiting for the code…');
    let attempts = 0;
    statusPoll = setInterval(async () => {
      attempts++;
      try {
        const statusResponse = await fetch(`/api/pair-code/status?token=${encodeURIComponent(data.pairingToken || '')}`, { cache: 'no-store' });
        const state = await readJson(statusResponse);
        if (!statusResponse.ok) throw new Error(state.error || 'Pairing status check failed.');
        if (state.connected || state.status === 'connected') { clearInterval(statusPoll); pairCodeWrap.hidden = true; currentCode = ''; showStatus('WhatsApp connected successfully. Send /menu from your WhatsApp in any chat or group to use the bot.'); resetPairButton(); return; }
        if (state.code) showPairCode(state.code);
        if (FAILED_STATES[state.status] || attempts >= 480) { clearInterval(statusPoll); pairCodeWrap.hidden = true; currentCode = ''; showStatus(FAILED_STATES[state.status] || 'Pairing did not complete. Check service logs and try again.', true); resetPairButton('Try again ↗'); }
      } catch (error) { clearInterval(statusPoll); showStatus(error.message, true); resetPairButton('Try again ↗'); }
    }, 1500);
  } catch (error) { showStatus(error.message, true); resetPairButton('Try again ↗'); }
});
copyButton?.addEventListener('click', async () => {
  if (!currentCode) return;
  try { await navigator.clipboard.writeText(currentCode); copyButton.textContent = 'Copied!'; setTimeout(() => { copyButton.textContent = 'Copy code'; }, 1800); }
  catch { showStatus('Copy was blocked by the browser. Select and copy the code manually.', true); }
});
