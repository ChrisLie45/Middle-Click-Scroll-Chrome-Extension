// Content scripts in frames on different origins can't reach each other, and
// can't ask for the page zoom. This relays an autoscroll message to every
// frame of the tab it came from, and answers zoom requests.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!sender.tab || msg.t === 'wake') return; // 'wake' only gets this worker running
  if (msg.t === 'zoom') {
    chrome.tabs.getZoom(sender.tab.id).then(respond, () => respond(1));
    return true;
  }
  chrome.tabs.sendMessage(sender.tab.id, msg).catch(() => {});
});

// Pages open before the extension was installed, updated, reloaded or switched
// back on have no content script, or one cut off from it: give them the
// current one. The session flag keeps this to once per start, not per wake-up.
chrome.storage.session.get('injected').then(async ({ injected }) => {
  if (injected) return;
  await chrome.storage.session.set({ injected: true });
  for (const tab of await chrome.tabs.query({})) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['defaults.js', 'autoscroll.js'],
      injectImmediately: true,
    }).catch(() => {}); // pages extensions can't run on
  }
});
