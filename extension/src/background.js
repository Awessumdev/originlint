// Service worker: only the optional daily scan of all zones lives here.
import { loadToken, runAndStore, newProblems, ensureDailyAlarm, ALARM } from './zonestore.js';

const t = (key, subs) => chrome.i18n.getMessage(key, subs && subs.map(String)) || key;

// Alarms don't survive extension updates and may not survive browser restarts.
chrome.runtime.onInstalled.addListener(async () => {
  // An alarm from a version that didn't store the flag yet still means "daily scan on".
  if (await chrome.alarms.get(ALARM)) await chrome.storage.local.set({ dailyScan: true });
  ensureDailyAlarm();
});
chrome.runtime.onStartup.addListener(() => { ensureDailyAlarm(); });

async function mutedList() {
  try {
    const { muted } = await chrome.storage.sync.get('muted');
    return Array.isArray(muted) ? muted : [];
  } catch { return []; }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const token = await loadToken();
  if (!token) return;
  const allowed = await chrome.permissions.contains({ origins: ['https://api.cloudflare.com/*'] }).catch(() => false);
  if (!allowed) return;

  // Pending fetches don't count as activity; an extension API call every 20 s keeps the worker
  // alive through a paced scan of a large account.
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);
  let report;
  try {
    report = await runAndStore(token, t);
  } catch {
    return; // busy, network or token trouble: try again tomorrow; a manual scan shows the error
  } finally {
    clearInterval(keepAlive);
  }
  const changed = newProblems(report, await mutedList());
  const canNotify = await chrome.permissions.contains({ permissions: ['notifications'] }).catch(() => false);
  if (!changed.length || !canNotify) return;
  chrome.notifications.create(ALARM, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: t('notifyTitle', [changed.length]),
    message: changed.slice(0, 3).map((e) => e.zone.name).join(', ') + (changed.length > 3 ? ' …' : ''),
  });
});

chrome.notifications?.onClicked.addListener((id) => {
  if (id === ALARM) chrome.tabs.create({ url: chrome.runtime.getURL('src/zones.html?daily') });
});
