const $ = id => document.getElementById(id);
$('year').textContent = new Date().getFullYear();
async function refresh() {
  $('connectionStatus').textContent = 'Checking service…';
  try {
    const [statusResponse, healthResponse] = await Promise.all([fetch('/api/status', { cache: 'no-store' }), fetch('/api/health', { cache: 'no-store' })]);
    if (!statusResponse.ok || !healthResponse.ok) throw new Error('Service status is unavailable.');
    const status = await statusResponse.json(); const health = await healthResponse.json();
    $('connectionStatus').textContent = `WhatsApp: ${status.connected ? 'Connected' : status.status}`;
    $('serviceHealth').textContent = `Service: ${health.ok ? 'Online' : 'Unavailable'} · Database: ${health.database ? 'Ready' : 'Not initialized'}`;
  } catch (error) { $('connectionStatus').textContent = 'Status unavailable'; $('serviceHealth').textContent = error.message; }
}
$('refreshButton').addEventListener('click', refresh);
refresh();
