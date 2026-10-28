// DEFAULTS and BASE_SPEED_AT_100 come from defaults.js.
const $ = (id) => document.getElementById(id);
const checkboxes = ['enabled', 'stickyMode', 'showMarker', 'linksOpenTabs', 'useOnWindows', 'sameSpeedOnAllDisplays',
  'pauseHover'];
// Chromium measures the pointer's distance from the click in screen points
// divided by devicePixelRatio, so on a 2x display the dead zone is twice as
// wide and speeds are reached twice as far out. Show what that comes to here
// (with "same speed on every display", a 1x display counts as a 2x one).
const scale = () => Math.max(devicePixelRatio || 1, $('sameSpeedOnAllDisplays').checked ? 2 : 1);
const sliders = {
  speed: (v) => `${(+v).toFixed(2)}×`,
  exponent: (v) => `${(+v).toFixed(1)}`,
  deadZone: (v) => `${Math.round(v * scale())} px`,
};

let blocked = [];
let currentHost = null;
let unavailable = null; // { page, why }: Chrome keeps extensions off the current page

let savedTimer = 0;
function flash(text, isError = false) {
  const el = $('saved');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(savedTimer);
  // An error stays up until the next successful save.
  if (!isError) savedTimer = setTimeout(() => el.classList.remove('show'), 900);
}

function save(patch) {
  chrome.storage.sync.set(patch, () => {
    if (!chrome.runtime.lastError) return flash('Saved');
    // e.g. the site list outgrew sync storage's 8 KB per-item limit.
    // Go back to showing what is actually stored.
    flash("Couldn't save", true);
    chrome.storage.sync.get(DEFAULTS, render);
  });
}

// --- Speed controls -------------------------------------------------------
// The track is filled up to the thumb, which CSS can't work out by itself.
function fillTrack(el) {
  const share = (el.value - el.min) / (el.max - el.min);
  el.style.setProperty('--fill', `calc(10px + ${share} * (100% - 20px))`);
}

function updatePreview() {
  const speed = +$('speed').value, exp = +$('exponent').value, dz = +$('deadZone').value;
  const at = (d) => (d / scale() <= dz ? 0 : Math.round(BASE_SPEED_AT_100 * speed * Math.pow(d / scale() / 100, exp)));
  $('preview').textContent =
    `Scroll speed at 50 px: ${at(50)} · 100 px: ${at(100)} · 200 px: ${at(200)} px/s, at 100% page zoom`;
}

// --- Disabled sites -------------------------------------------------------
// Reduce whatever was typed (a URL, host:port, *.domain) to a bare hostname,
// or '' if it isn't one.
const normalize = (s) => {
  s = s.trim().toLowerCase();
  if (!/^[a-z]+:\/\//.test(s)) s = 'http://' + s;
  try {
    const host = new URL(s.replace('://*.', '://')).hostname.replace(/^www\./, '');
    // Chrome escapes characters a hostname can't contain instead of rejecting them.
    return host.includes('%') ? '' : host;
  } catch {
    return '';
  }
};

// Same rule as the content script: an entry covers its subdomains.
const covers = (entry, host) => host === entry || host.endsWith('.' + entry);

function saveBlocked() {
  save({ blockedSites: blocked.join('\n') });
  renderBlocked();
}

function renderBlocked() {
  const ul = $('sites');
  ul.textContent = '';
  if (!blocked.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None';
    ul.append(li);
  }
  for (const site of blocked) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = site;
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.title = `Remove ${site}`;
    rm.addEventListener('click', () => {
      blocked = blocked.filter((s) => s !== site);
      saveBlocked();
    });
    li.append(name, rm);
    ul.append(li);
  }
  renderSite();
}

function renderSite() {
  // On Windows the extension is off unless the user picks it over Chrome's own.
  if (BUILT_IN_AUTOSCROLL) {
    $('winCard').hidden = false;
    $('winState').textContent = $('useOnWindows').checked
      ? 'This extension is used instead of Chrome\u2019s own autoscroll'
      : 'Chrome autoscrolls with the middle button by itself, so this extension stays off. Switch on to use it instead';
    if (!$('useOnWindows').checked) {
      $('site').hidden = true;
      return;
    }
  }
  if (unavailable) {
    $('site').hidden = false;
    $('site').classList.add('unavailable');
    $('siteHost').textContent = unavailable.page;
    $('siteState').textContent = unavailable.why;
    $('siteSwitch').hidden = true;
    return;
  }
  if (!currentHost) return;
  const host = currentHost.replace(/^www\./, '');
  const entry = blocked.find((e) => covers(e, currentHost));
  $('site').hidden = false;
  $('siteHost').textContent = host;
  $('siteEnabled').checked = !entry;
  $('siteState').textContent = !$('enabled').checked
    ? 'Autoscroll is turned off everywhere'
    : !entry ? 'Autoscroll is on for this site'
    : entry === host ? 'Autoscroll is off for this site'
    : `Autoscroll is off for all of ${entry}`;
  document.body.classList.toggle('off', !$('enabled').checked);
}

$('siteEnabled').addEventListener('change', () => {
  const host = currentHost.replace(/^www\./, '');
  if ($('siteEnabled').checked) {
    blocked = blocked.filter((e) => !covers(e, currentHost));
  } else if (!blocked.includes(host)) {
    blocked.push(host);
  }
  saveBlocked();
});

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const site = normalize($('addInput').value);
  if (!site) {
    $('addInput').classList.add('invalid');
    $('addInput').focus();
    return;
  }
  if (!blocked.includes(site)) {
    blocked.push(site);
    saveBlocked();
  }
  $('addInput').value = '';
});

$('addInput').addEventListener('input', () => $('addInput').classList.remove('invalid'));

// --- Load / reset ---------------------------------------------------------
function render(s) {
  for (const k of checkboxes) $(k).checked = s[k];
  for (const [k, fmt] of Object.entries(sliders)) {
    $(k).value = s[k];
    $(k + 'Out').textContent = fmt(s[k]);
    fillTrack($(k));
  }
  blocked = s.blockedSites.split(/[\s,]+/).map(normalize).filter(Boolean);
  renderBlocked();
  updatePreview();
  syncResetButtons();
}

chrome.storage.sync.get(DEFAULTS, render);

for (const k of checkboxes) {
  $(k).addEventListener('change', () => {
    save({ [k]: $(k).checked });
    renderSite();
  });
}
$('sameSpeedOnAllDisplays').addEventListener('change', () => {
  $('deadZoneOut').textContent = sliders.deadZone($('deadZone').value);
  updatePreview();
});

// Per-slider ↺ buttons, shown only when the value differs from the default.
function syncResetButtons() {
  for (const btn of document.querySelectorAll('.reset1')) {
    btn.hidden = +$(btn.dataset.key).value === DEFAULTS[btn.dataset.key];
  }
}

for (const [k, fmt] of Object.entries(sliders)) {
  $(k).addEventListener('input', () => {
    $(k + 'Out').textContent = fmt($(k).value);
    fillTrack($(k));
    updatePreview();
    syncResetButtons();
  });
  $(k).addEventListener('change', () => save({ [k]: +$(k).value }));
}

for (const btn of document.querySelectorAll('.reset1')) {
  btn.addEventListener('click', () => {
    const k = btn.dataset.key;
    $(k).value = DEFAULTS[k];
    $(k + 'Out').textContent = sliders[k](DEFAULTS[k]);
    fillTrack($(k));
    save({ [k]: DEFAULTS[k] });
    updatePreview();
    syncResetButtons();
  });
}

$('reset').addEventListener('click', () => {
  // Keep the site list; reset only behavior settings.
  const { blockedSites, ...rest } = DEFAULTS;
  save(rest);
  render({ ...DEFAULTS, blockedSites: blocked.join('\n') });
});

// --- Current site (toolbar popup only) -------------------------------------
// activeTab exposes the tab's URL when the popup is opened from the toolbar.
// In the embedded options page there is no URL and the card stays hidden.
chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  if (!tab?.url) return;
  const { protocol, hostname, pathname } = new URL(tab.url);
  // Chrome runs no extension on its own pages, the Web Store, other
  // extensions' pages or (unless the user allows it) local files. Say so
  // rather than offer a switch that does nothing.
  const webStore = hostname === 'chromewebstore.google.com' ||
    (hostname === 'chrome.google.com' && pathname.startsWith('/webstore'));
  if (webStore) {
    unavailable = { page: 'Chrome Web Store', why: 'Chrome doesn\u2019t allow extensions on this page' };
  } else if (protocol === 'file:') {
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
      unavailable = { page: 'Local file', why: 'Turn on \u201cAllow access to file URLs\u201d for this extension in chrome://extensions' };
    }
  } else if (protocol !== 'http:' && protocol !== 'https:') {
    unavailable = { page: protocol === 'chrome-extension:' ? 'Extension page' : 'Chrome page',
      why: 'Chrome doesn\u2019t allow extensions on this page' };
  } else {
    currentHost = hostname;
  }
  renderSite();
});
