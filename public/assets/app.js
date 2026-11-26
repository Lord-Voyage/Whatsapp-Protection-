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
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Pairing request failed.');
    if (data.code) { currentCode = data.code; pairCode.textContent = data.code; pairCodeWrap.hidden = false; showStatus('Pairing code generated. Enter it in WhatsApp Linked devices.'); pairButton.disabled = false; pairButton.textContent = 'Generate Pairing Code ↗'; return; }
    let attempts = 0;
    showStatus(data.message || 'Pairing request started. Waiting for the code…');
    statusPoll = setInterval(async () => {
      attempts++;
      try {
        const statusResponse = await fetch(`/api/pair-code/status?token=${encodeURIComponent(data.pairingToken || '')}`, { cache: 'no-store' });
        const state = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(state.error || 'Pairing status check failed.');
        if (state.code) { currentCode = state.code; pairCode.textContent = state.code; pairCodeWrap.hidden = false; showStatus('Pairing code generated. Enter it in WhatsApp Linked devices.'); clearInterval(statusPoll); pairButton.disabled = false; pairButton.textContent = 'Generate Pairing Code ↗'; }
        else if (state.status === 'connection_lost' || attempts >= 120) { clearInterval(statusPoll); showStatus('Pairing did not complete. Check service logs and try again.', true); pairButton.disabled = false; pairButton.textContent = 'Try again ↗'; }
      } catch (error) { clearInterval(statusPoll); showStatus(error.message, true); pairButton.disabled = false; pairButton.textContent = 'Try again ↗'; }
    }, 1500);
  } catch (error) { showStatus(error.message, true); pairButton.disabled = false; pairButton.textContent = 'Try again ↗'; }
});
copyButton?.addEventListener('click', async () => {
  if (!currentCode) return;
  try { await navigator.clipboard.writeText(currentCode); copyButton.textContent = 'Copied!'; setTimeout(() => { copyButton.textContent = 'Copy code'; }, 1800); }
  catch { showStatus('Copy was blocked by the browser. Select and copy the code manually.', true); }
});
