import { API_ORIGIN, verifyToken } from './cfapi.js';
import { TOKEN_PERMISSIONS } from './apichecks.js';

const t = (key, subs) => chrome.i18n.getMessage(key, subs && subs.map(String)) || key;
const $ = (id) => document.getElementById(id);

document.documentElement.lang = chrome.i18n.getUILanguage();
document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
$('perms').replaceChildren(...TOKEN_PERMISSIONS
  .map((p) => { const li = document.createElement('li'); const c = document.createElement('code'); c.textContent = p; li.append(c); return li; }));

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = 'opt-status ' + cls;
}

function fieldError(text) {
  $('tokenError').hidden = !text;
  $('tokenError').textContent = text || '';
  $('token').setAttribute('aria-invalid', text ? 'true' : 'false');
  if (text) $('token').focus();
}

async function showSaved() {
  let saved = '';
  try { ({ cfToken: saved = '' } = await chrome.storage.local.get('cfToken')); } catch {}
  $('remove').hidden = !saved;
  if (saved) setStatus(t('opt_saved', [saved.slice(-4)]), 'ok');
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('token').value.trim();
  if (!token) return fieldError(t('opt_tokenEmpty'));
  if (!/^[A-Za-z0-9_-]{30,}$/.test(token)) return fieldError(t('opt_tokenFormat'));
  fieldError('');
  // Ask for api.cloudflare.com inside the submit gesture, before any other await.
  const request = chrome.permissions.request({ origins: [API_ORIGIN] });
  $('save').disabled = true;
  try {
    if (!(await request.catch(() => false))) return setStatus(t('opt_permDenied'), 'error');
    setStatus(t('opt_verifying'));
    const info = await verifyToken(token);
    if (!info || info.status !== 'active') return setStatus(t('opt_inactive', [info ? info.status : '?']), 'error');
    await chrome.storage.local.set({ cfToken: token });
    $('token').value = '';
    await showSaved();
  } catch (err) {
    setStatus(t('opt_verifyFailed', [err.message || err]), 'error');
  } finally {
    $('save').disabled = false;
  }
});

$('remove').addEventListener('click', async () => {
  try { await chrome.storage.local.remove('cfToken'); } catch {}
  try { await chrome.permissions.remove({ origins: [API_ORIGIN] }); } catch {}
  $('remove').hidden = true;
  setStatus(t('opt_removed'));
});

showSaved();
