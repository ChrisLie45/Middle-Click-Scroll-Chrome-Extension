// Settings shared by the content script and the options page (defaults are
// Chromium's, except sameSpeedOnAllDisplays).
// Blink's speed curve:
//   d        = pointer distance in screen points / devicePixelRatio, zero
//              inside the per-axis dead zone (deadZone is in the same units)
//   velocity = sign(d) * |d|^2.2 * 0.000008
//   speed    = velocity * 5000 per second (ui::FixedVelocityCurve)
//            = |d|^2.2 * 0.04 screen points/s
// The curve is anchored at d = 100 so changing the exponent doesn't change
// speed there.
// (var, not const: the background worker runs this file a second time in pages
// that were open when the extension was reloaded.)
var BASE_SPEED_AT_100 = 0.04 * Math.pow(100, 2.2); // ~1005 px/s
var DEFAULTS = {
  enabled: true,
  speed: 1,
  exponent: 2.2,
  deadZone: 15,
  stickyMode: true,
  showMarker: false,
  linksOpenTabs: true,
  blockedSites: '',
  sameSpeedOnAllDisplays: true, // unlike Chrome: a standard display scrolls like a Retina one
  pauseHover: false,     // the layer on every page while autoscrolling
  useOnWindows: false, // instead of Chrome's own (see below)
};

// Chrome on Windows has middle-click autoscroll of its own, switched on, so
// there the extension stays off unless useOnWindows is set. (navigator.
// userAgentData is missing on plain-http pages.)
var BUILT_IN_AUTOSCROLL = /^win/i.test(navigator.userAgentData?.platform || navigator.platform || '');
