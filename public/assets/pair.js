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
let activeCode = '';
let pollTimer = null;
let pairingToken = '';
function status(message, error = false) {
  statusNode.textContent = message;
  statusNode.dataset.state = error ? 'error' : 'info';
}
function showCode(code) {
  activeCode = code;
  codeNode.textContent = code;
  codeWrap.hidden = false;
  status('Pairing code ready. Enter it in WhatsApp Linked devices.');
  button.disabled = false;
  button.textContent = 'Generate Pairing Code ↗';
  if (pollTimer) clearInterval(pollTimer);
}
form?.addEventListener('submit', async event => {
  event.preventDefault();
  if (pollTimer) clearInterval(pollTimer);
  activeCode = ''; pairingToken = ''; codeWrap.hidden = true;
  const phone = document.getElementById('phone').value.replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) return status('Enter a valid international phone number including its country code.', true);
  button.disabled = true; button.textContent = 'Requesting code…'; status('Contacting the persistent WhatsApp pairing service…');
  try {
    const response = await fetch('/api/pair-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Pairing request failed.');
    pairingToken = data.pairingToken || '';
    if (data.code) return showCode(data.code);
    status(data.message || 'Pairing started. Waiting for Baileys to return the code…');
    let attempts = 0;
    pollTimer = setInterval(async () => {
      attempts += 1;
      try {
        const result = await fetch(`/api/pair-code/status?token=${encodeURIComponent(pairingToken)}`, { cache: 'no-store' });
        const current = await result.json();
        if (!result.ok) throw new Error(current.error || 'Could not check pairing status.');
        if (current.code) return showCode(current.code);
        if (current.status === 'connected') { clearInterval(pollTimer); status('WhatsApp connected successfully.'); button.disabled = false; button.textContent = 'Generate Pairing Code ↗'; }
        else if (current.status === 'connection_lost' || attempts >= 120) { clearInterval(pollTimer); status('Pairing did not complete. Check the service logs and try again.', true); button.disabled = false; button.textContent = 'Try again ↗'; }
      } catch (error) { clearInterval(pollTimer); status(error.message, true); button.disabled = false; button.textContent = 'Try again ↗'; }
    }, 1500);
  } catch (error) { status(error.message, true); button.disabled = false; button.textContent = 'Try again ↗'; }
});
copyButton?.addEventListener('click', async () => {
  if (!activeCode) return;
  try { await navigator.clipboard.writeText(activeCode); copyButton.textContent = 'Copied!'; setTimeout(() => { copyButton.textContent = 'Copy code'; }, 1800); }
  catch { status('Clipboard access was blocked. Select the code and copy it manually.', true); }
});
