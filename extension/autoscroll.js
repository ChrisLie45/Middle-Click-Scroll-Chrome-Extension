// Windows-style middle-click autoscroll, modeled on Chromium.
//  - When it starts and stops, and what the page gets to see, follow Blink
//    (Node::DefaultEventHandler, EventHandler, AutoscrollController).
//  - What scrolls follows the compositor (cc::InputHandler): one scroller is
//    latched when the pointer first leaves the dead zone and nothing else
//    moves until autoscroll ends.
// DEFAULTS and BASE_SPEED_AT_100 come from defaults.js.
(() => {
  // When the extension is reloaded or updated, the copy of this script that
  // was running in open pages lives on without its extension, and the
  // background worker injects the new one beside it. `valid` tells them apart.
  const valid = () => {
    try { return !!chrome.runtime.id; } catch { return false; }
  };
  if (window.__middleClickAutoscrollLoaded?.()) return;
  window.__middleClickAutoscrollLoaded = valid;

  let settings = { ...DEFAULTS };
  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    if (settings.sameSpeedOnAllDisplays) refreshZoom(); // see 'resize' below
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) {
      settings[k] = newValue === undefined ? DEFAULTS[k] : newValue;
    }
  });

  // A disabled site covers its subdomains and every frame embedded in its
  // pages, so check the top-level page's host as well as this frame's own.
  const hostOf = (origin) => {
    try { return new URL(origin).hostname; } catch { return ''; }
  };
  const hosts = [location.hostname, hostOf(location.ancestorOrigins[location.ancestorOrigins.length - 1])];
  const isBlocked = () => settings.blockedSites.split(/[\s,]+/).filter(Boolean).some((s) => {
    s = s.replace(/^\*\./, '').toLowerCase();
    return hosts.some((h) => h === s || h.endsWith('.' + s));
  });
  const isOff = () => !settings.enabled || (BUILT_IN_AUTOSCROLL && !settings.useOnWindows) || isBlocked();

  // --- Frames -------------------------------------------------------------
  // This frame and its same-origin ancestors, outermost last. They can read
  // each other's documents, so they act as one unit, as frames in one
  // renderer process do in Chromium.
  const frames = [];
  for (let w = window; ; w = w.parent) {
    frames.push(w);
    if (!w.frameElement) break; // top page, or a parent on another origin
  }
  const outer = frames[frames.length - 1];

  // State shared by the copies of this script running in the unit's frames
  // (they see each other's globals, pages don't). A unit left behind by copies
  // from before an extension reload has no valid member and is replaced.
  const UNIT = '__middleClickAutoscroll3';
  // The key of a child unit's postMessage (see 'message' below). Copies left
  // behind by an update still listen for theirs and swallow it, so a version
  // that changes how units talk changes this key too (1.1.0 and older: __mcs).
  const MSG = '__mcs4';
  let unit = outer[UNIT];
  if (!unit || ![...unit.sync.values()].some((member) => member.valid())) {
    unit = outer[UNIT] = {
      session: null,       // the autoscroll in progress in this tab, if any
      sync: new Map(),     // window -> { run, valid }: each frame's "session changed" callback
      voided: new Set(),   // mouse buttons whose coming click must not reach the page
      settling: new Map(), // element -> finish(), while it eases onto a snap point
      nonces: new Map(),   // nonce -> { source, win, frame }: child units that introduced themselves
      waiting: new Map(),  // requests from child units we can't place yet
      post: null,          // the outer frame's postMessage to its parent
      marker: null,        // { host, raise } of the origin marker, while shown
    };
  }
  // The spare port only marks the message as ours, so that the listener in
  // the parent can skip every other message without reading it.
  if (window === outer && outer !== top) {
    unit.post = (data) => parent.postMessage(data, '*', [new MessageChannel().port1]);
  }
  const notify = () => {
    for (const [win, member] of [...unit.sync]) {
      if (win.closed) unit.sync.delete(win); // its frame was removed
      else try { member.run(); } catch { /* one frame's trouble must not stop the others */ }
    }
  };

  // Units on other origins are reached through the background worker, which
  // relays to every frame of the tab. `sid` is the session's id, `nonce` the
  // asking child unit's, x/y and px/py screen points.
  //   start    sid x y cursor adopted   owner, to all: a session began at x,y
  //                                      (adopted: the 'adopt' it answers)
  //   ping     sid x y px py cursor     owner, every second: still running
  //   cursor   sid cursor               owner: the cursor changed
  //   ptr      sid x y                  any unit: the pointer moved
  //   up       sid button               a unit to the owner: a button was released
  //   stop     sid                      any unit: the session is over
  //   blur     sid                      a unit to the top page: focus moved
  //   hello    sid nonce                child to parent: is my frame scrolling="no"?
  //   frame    sid nonce off            parent's answer to 'hello'
  //   bubble   sid nonce hx hy px py haveFirst
  //                                     child to parent: nothing here latched
  //                                     going hx,hy (-1, 0, 1); try out there
  //   driving  sid nonce x y            parent: it latched, and can scroll on x/y
  //   adopt    nonce x y px py origin   child to same-site parent: nothing to
  //                                     scroll here, start out there (origin:
  //                                     the first asker's nonce, when passed on)
  //   zoom, wake                        to the worker only
  const send = (msg) => {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* extension was reloaded */ }
  };
  // Session ids and nonces. getRandomValues, unlike randomUUID, works on
  // plain-http pages too.
  const token = () => Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join('');

  // Chromium keeps same-site frames in one process, where autoscroll carries
  // on from a frame into the page around it; other frames are on their own.
  // Without the public suffix list this is a guess at "same site".
  const siteOf = (origin) => {
    let url;
    try { url = new URL(origin); } catch { return null; }
    const host = url.hostname, parts = host.split('.');
    if (/^[\d.]+$|:/.test(host)) return url.protocol + host;
    const twoPartSuffix = parts.length > 2 && parts[parts.length - 1].length === 2 &&
      /^(com?|org|net|gov|edu|ac|or|ne|go)$/.test(parts[parts.length - 2]);
    return url.protocol + parts.slice(twoPartSuffix ? -3 : -2).join('.');
  };
  const sameSiteParent = () => {
    const mine = siteOf(outer.origin);
    return !!mine && mine === siteOf(outer.location.ancestorOrigins[0]);
  };

  // --- Scrollers ----------------------------------------------------------
  const XHTML = 'http://www.w3.org/1999/xhtml', XLINK = 'http://www.w3.org/1999/xlink';
  const SIZE = { x: 'Width', y: 'Height' };
  const styleOf = (el) => el.ownerDocument.defaultView.getComputedStyle(el);
  const cap = (axis) => axis.toUpperCase(); // 'y' -> overflowY, overscrollBehaviorY
  const scrolls = (v) => v === 'auto' || v === 'scroll' || v === 'overlay'; // the user can scroll it
  const clips = (v) => scrolls(v) || v === 'hidden';                        // a scroll container's axis
  const chains = (v) => v === 'auto' || v === 'chain';                      // overscroll-behavior passes scroll on

  // The element whose overflow the viewport takes (Document::ViewportDefiningElement).
  function viewportDefiner(doc) {
    const root = doc.documentElement, body = doc.body;
    const rootStyle = styleOf(root);
    if (rootStyle.overflowX !== 'visible' || rootStyle.overflowY !== 'visible') return root;
    if (!body || body.localName !== 'body' || root.localName !== 'html') return root;
    const bodyStyle = styleOf(body);
    const contained = (style) => style.contain !== 'none' ||
      (style.containerType || 'normal') !== 'normal' || (style.contentVisibility || 'visible') !== 'visible';
    if (bodyStyle.display === 'none' || contained(rootStyle) || contained(bodyStyle)) return root;
    return body;
  }

  // <iframe scrolling="no">. A parent on another origin has to tell us.
  const scrollingOff = (win) => {
    const frame = win.frameElement;
    if (!frame) return win === outer && !!unit.session?.frameOff;
    return /^(no|off|noscroll)$/i.test(frame.getAttribute('scrolling') || '');
  };

  // Does content overflow towards negative scroll positions on this axis?
  // Chromium knows the real scroll range; from here it has to be worked out
  // from the writing mode, the direction and, in a flex box, its flow.
  function reversedAxis(style, axis, flex) {
    const mode = style.writingMode || 'horizontal-tb';
    const rtl = style.direction === 'rtl';
    let inline = mode === 'sideways-lr' ? !rtl : rtl;
    let block = mode === 'vertical-rl' || mode === 'sideways-rl';
    if (flex && /flex/.test(style.display)) {
      const column = style.flexDirection.startsWith('column');
      const backwards = style.flexDirection.endsWith('reverse'), wrapBackwards = style.flexWrap === 'wrap-reverse';
      if (column ? backwards : wrapBackwards) block = !block;
      if (column ? wrapBackwards : backwards) inline = !inline;
    }
    return axis === (mode === 'horizontal-tb' ? 'x' : 'y') ? inline : block;
  }

  /**
   * Scrollers answer the questions Blink and cc ask of a scroll box: an
   * element's, or (below) a document's viewport. `axis` is 'x' or 'y'.
   * @typedef {object} Scroller
   * @property {(axis: string) => string} overflow       its overflow-x/y, as layout uses it
   * @property {(axis: string) => string} overscroll     its overscroll-behavior-x/y
   * @property {(axis: string) => number} pos            scroll position
   * @property {(axis: string) => number} range          how far it can scroll
   * @property {(axis: string) => boolean} reversed      content overflows towards negative positions
   * @property {(axis: string) => boolean} userScrollable  the user may scroll it on that axis
   * @property {(axis: string) => boolean} propagates    scrolling passes on past it
   * @property {() => boolean} hasNode                   it has a scroll node in the compositor
   * @property {() => number} cssZoom                    CSS zoom on its own px
   * @property {(x: number, y: number) => void} scrollBy
   * @property {(x: number, y: number, behavior: string) => void} scrollTo
   * @property {() => Element[]} snappers                elements that carry its scroll-snap-type
   * @property {EventTarget} events                      where its scrollend fires
   * @property {() => boolean} alive                     still on the page (may throw)
   * @property {boolean} [terminal]                      the page's own viewport (set by scrollChain)
   */
  /** @returns {Scroller} */
  function viewportOf(doc) {
    const win = doc.defaultView, root = doc.documentElement;
    const sized = () => doc.scrollingElement || root;
    const overflow = (axis) => {
      const v = styleOf(viewportDefiner(doc))['overflow' + cap(axis)];
      return v === 'visible' ? 'auto' : v === 'clip' ? 'hidden' : v;
    };
    const overscroll = (axis) => styleOf(root)['overscrollBehavior' + cap(axis)];
    const pos = (axis) => (axis === 'x' ? win.scrollX : win.scrollY);
    // Quirks mode with a <body> that scrolls by itself has no scrollingElement;
    // the body's client size is still the viewport's there.
    const range = (axis) => (doc.scrollingElement || doc.compatMode !== 'BackCompat' || !doc.body
      ? sized()['scroll' + SIZE[axis]] - sized()['client' + SIZE[axis]]
      : root['scroll' + SIZE[axis]] - doc.body['client' + SIZE[axis]]);
    return {
      overflow, overscroll, pos, range,
      // the viewport takes its direction from <body>
      reversed: (axis) => reversedAxis(styleOf(doc.body?.localName === 'body' ? doc.body : root), axis, false),
      // PaintLayerScrollableArea::UserInputScrollable for a LayoutView
      userScrollable: (axis) => scrolls(overflow(axis)) && !scrollingOff(win) &&
        !(doc.fullscreenElement && doc.fullscreenElement !== root),
      propagates: (axis) => chains(overscroll(axis)),
      // Only a process's outermost view always has a scroll node; an embedded
      // frame's view needs a reason, like any box (see boxOf).
      hasNode: () => win === top || (win === outer && !sameSiteParent()) ||
        (scrolls(overflow('x')) && range('x') > 0) || (scrolls(overflow('y')) && range('y') > 0) ||
        pos('x') !== 0 || pos('y') !== 0 || !chains(overscroll('x')) || !chains(overscroll('y')),
      cssZoom: () => 1,
      scrollBy: (x, y) => win.scrollBy({ left: x, top: y, behavior: 'instant' }),
      scrollTo: (x, y, behavior) => win.scrollTo({ left: x, top: y, behavior }),
      snappers: () => [root, doc.body].filter(Boolean),
      events: doc, // where scrollend fires
      alive: () => win.document === doc,
    };
  }

  const NOT_A_BOX = /^(inline|contents|none|table-(row|column|header|footer).*)$/;
  const REPLACED = new Set(['iframe', 'frame', 'img', 'video', 'audio', 'canvas', 'embed', 'object']);

  /** @returns {Scroller | null} null unless the element is a scroll container. */
  function boxOf(el) {
    const doc = el.ownerDocument;
    if (el === doc.documentElement) return null; // its overflow is the viewport's
    const style = styleOf(el);
    // A text field scrolls an inner box of its own, whatever its style says.
    const field = el.localName === 'input' && el.namespaceURI === XHTML &&
      (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    if (!field) {
      if (!clips(style.overflowX) && !clips(style.overflowY)) return null;
      if (NOT_A_BOX.test(style.display) || REPLACED.has(el.localName)) return null;
      if (el === doc.body && viewportDefiner(doc) === el) return null; // also the viewport's
    }
    const overflow = (axis) => (field ? 'scroll' : style['overflow' + cap(axis)]);
    const overscroll = (axis) => (field ? 'auto' : style['overscrollBehavior' + cap(axis)]);
    const pos = (axis) => (axis === 'x' ? el.scrollLeft : el.scrollTop);
    // In quirks mode <body>'s client size is the viewport's, not its own.
    const quirksBody = el === doc.body && doc.compatMode === 'BackCompat';
    const border = (side) => parseFloat(style['border' + side + 'Width']) || 0;
    const client = (axis) => (!quirksBody ? el['client' + SIZE[axis]]
      : el['offset' + SIZE[axis]] - (axis === 'x' ? border('Left') + border('Right') : border('Top') + border('Bottom')));
    const range = (axis) => el['scroll' + SIZE[axis]] - client(axis);
    return {
      overflow, overscroll, pos, range,
      reversed: (axis) => reversedAxis(style, axis, true),
      userScrollable: (axis) => scrolls(overflow(axis)),
      // cc resets overscroll-behavior on an axis the box can't scroll at all
      propagates: (axis) => !clips(overflow(axis)) || chains(overscroll(axis)),
      // Not every scroll container has a scroll node in the compositor
      // (NeedsScrollAndScrollTranslation in paint_property_tree_builder.cc).
      hasNode: () => style.visibility === 'visible' && (
        (scrolls(overflow('x')) && range('x') > 0) || (scrolls(overflow('y')) && range('y') > 0) ||
        pos('x') !== 0 || pos('y') !== 0 || !chains(overscroll('x')) || !chains(overscroll('y'))),
      // scrollBy counts in the element's own px, which CSS zoom stretches
      cssZoom: () => el.currentCSSZoom || 1,
      scrollBy: (x, y) => el.scrollBy({ left: x, top: y, behavior: 'instant' }),
      scrollTo: (x, y, behavior) => el.scrollTo({ left: x, top: y, behavior }),
      snappers: () => [el],
      events: el,
      alive: () => el.isConnected && el.getClientRects().length > 0,
    };
  }

  // A scroller whose frame was removed or navigated away throws when asked.
  const alive = (s) => {
    try { return s.alive(); } catch { return false; }
  };

  // Blink: LayoutBox::HasScrollableOverflowX/Y, IsUserScrollable, ScrollManager::CanPropagate
  const overflows = (s, axis) => scrolls(s.overflow(axis)) && s.range(axis) > 0;
  const userScrollable = (s) => overflows(s, 'x') || overflows(s, 'y');
  const passesOn = (s, axis) =>
    (!s.userScrollable('x') && !s.userScrollable('y')) || chains(s.overscroll(axis));

  /**
   * cc: InputHandler::CanConsumeDelta, for the direction the pointer went.
   * @param {Scroller} s
   * @param {string} axis 'x' or 'y'
   * @param {number} sign -1, 0 or 1: the pointer's direction on that axis
   */
  function room(s, axis, sign) {
    if (!sign || !s.userScrollable(axis)) return false;
    const at = s.pos(axis), range = s.range(axis);
    const [min, max] = at < 0 || (at === 0 && s.reversed(axis)) ? [-range, 0] : [0, range];
    return sign > 0 ? max - at >= 1 : at - min >= 1;
  }
  const consumes = (s, hx, hy) => room(s, 'x', hx) || room(s, 'y', hy);

  // --- Walking up from the click ------------------------------------------
  // Extensions may look into closed shadow roots, as Chromium's own code can.
  const shadowOf = (el) => {
    try { return chrome.dom.openOrClosedShadowRoot(el); } catch { return el.shadowRoot; }
  };

  // From an element down to what is really at a point, however deep in
  // closed shadow roots. `each` gets every shadow root on the way.
  function deepest(el, x, y, each) {
    for (let root; el && (root = shadowOf(el));) {
      each?.(root);
      const inner = root.elementFromPoint(x, y);
      if (!inner || inner === el || inner.getRootNode() !== root) break;
      el = inner;
    }
    return el;
  }
  const deepTarget = (e) =>
    deepest(e.composedPath().find((n) => n.nodeType === 1), e.clientX, e.clientY);

  // Parent in the flat tree: through slots and shadow roots, as layout sees it.
  function flatParent(el) {
    const parent = el.parentNode;
    if (!parent || parent.nodeType === 9) return null;
    if (parent.nodeType === 11) return parent.host || null;
    const root = shadowOf(parent);
    if (!root) return parent;
    return el.assignedSlot ||
      [...root.querySelectorAll('slot')].find((slot) => slot.assignedNodes().includes(el)) || parent;
  }

  const inTopLayer = (el) => {
    try { return el.matches(':modal, :popover-open, :fullscreen'); } catch { return false; }
  };

  // The element and what layout puts around it, innermost first: flat-tree
  // ancestors, top-layer elements straight under the root, then out through
  // the <iframe>s of same-origin parent pages (Chromium's LocalOwner).
  function* ancestry(el) {
    while (el) {
      yield el;
      const doc = el.ownerDocument;
      el = el === doc.documentElement ? doc.defaultView?.frameElement
        : inTopLayer(el) ? doc.documentElement
        : flatParent(el);
    }
  }

  // Node::EnclosingLinkEventParentOrSelf: middle-click on a link opens a tab.
  const isLink = (el) => el.matches('a[href], area[href]') ||
    (el.localName === 'a' && el.hasAttributeNS(XLINK, 'href'));
  function onLink(el) {
    for (; el; el = flatParent(el)) if (isLink(el)) return true;
    return false;
  }

  // Blink's part. Node::DefaultEventHandler climbs the layout tree for a box
  // the user can scroll and starts only if there is one;
  // AutoscrollController::StartMiddleClickAutoscroll then picks the boxes that
  // give the cursor its arrows. As there, an axis closed by a scroller's
  // overscroll-behavior opens again at the next box that isn't a scroll
  // container (a null in `boxes`).
  function findBoxes(target) {
    const boxes = [];
    for (const el of ancestry(target)) {
      const display = styleOf(el).display;
      if (display !== 'inline' && display !== 'contents') boxes.push(boxOf(el));
      if (el === el.ownerDocument.documentElement) boxes.push(viewportOf(el.ownerDocument));
    }
    const first = boxes.findIndex((s) => s && userScrollable(s));
    if (first < 0) return null;
    let v = null, h = null, passV = true, passH = true;
    for (const s of boxes.slice(first)) {
      if (s && passV && !v && overflows(s, 'y')) v = s;
      if (s && passH && !h && overflows(s, 'x')) h = s;
      passV = !s || passesOn(s, 'y');
      passH = !s || passesOn(s, 'x');
      if ((!passV && !passH) || (v && h)) break;
    }
    return { v, h };
  }

  // The compositor's part: the scroll nodes from the click outwards. A box is
  // scrolled by the scrollers around its containing block, which for fixed
  // and absolute boxes are not all of its ancestors
  // (LayoutObject::ComputeIsFixedContainer / ComputeIsAbsoluteContainer).
  function scrollChain(target) {
    const chain = [];
    let doc = null, follow = '';
    for (const el of ancestry(target)) {
      if (el.ownerDocument !== doc) {
        doc = el.ownerDocument;
        follow = '';
      }
      const style = styleOf(el);
      const holdsFixed = style.transform !== 'none' || style.translate !== 'none' ||
        style.rotate !== 'none' || style.scale !== 'none' || style.perspective !== 'none' ||
        style.filter !== 'none' || style.backdropFilter !== 'none' ||
        style.transformStyle === 'preserve-3d' || style.contentVisibility === 'auto' ||
        /paint|layout|strict|content/.test(style.contain) ||
        /transform|translate|rotate|scale|perspective|filter|contain|offset-path/.test(style.willChange);
      const contains = follow === 'fixed' ? holdsFixed
        : follow === 'absolute' ? holdsFixed || style.position !== 'static'
        : true;
      if (contains) {
        const s = boxOf(el);
        if (s && s.hasNode()) chain.push(s);
        follow = style.position;
      }
      if (el === doc.documentElement) {
        const view = viewportOf(doc);
        view.terminal = outer === top && doc === outer.document; // cc never chains past the page's own viewport
        if (view.hasNode()) chain.push(view);
      }
    }
    return chain;
  }

  /**
   * cc::InputHandler::FindNodeToLatch, for the direction the pointer first
   * went. `first` is what it falls back on when nothing can move that way.
   * @param {Scroller[]} chain from scrollChain, innermost first
   * @param {number} hx -1, 0 or 1
   * @param {number} hy -1, 0 or 1
   * @returns {{ hit: Scroller | null, first: Scroller | null }}
   */
  function findLatch(chain, hx, hy) {
    let first = null;
    for (const s of chain) {
      if (s.terminal) return { hit: s, first };
      const open = s.propagates('x') && s.propagates('y');
      if (!s.userScrollable('x') && !s.userScrollable('y') && open) continue;
      first ||= s;
      if (consumes(s, hx, hy)) return { hit: s, first };
      if ((hx && !s.propagates('x')) || (hy && !s.propagates('y'))) return { hit: s, first };
    }
    return { hit: null, first };
  }

  // --- Speed --------------------------------------------------------------
  // Blink divides the pointer's distance by devicePixelRatio (display scale x
  // page zoom) before applying its curve, and the fling it starts moves the
  // content by that many points on screen per second, whatever the zoom. So
  // the same hand movement scrolls about 4.6 times faster on a standard
  // display than on a Retina one, whose points are about as big. With
  // sameSpeedOnAllDisplays, a standard display counts as a Retina one.
  function speed(distance) {
    const scale = devicePixelRatio || 1;
    const d = Math.abs(distance) / (settings.sameSpeedOnAllDisplays ? Math.max(scale, 2 * zoom) : scale);
    if (d <= settings.deadZone) return 0;
    return Math.sign(distance) * BASE_SPEED_AT_100 * settings.speed *
      Math.pow(d / 100, settings.exponent);
  }

  let zoom = 1; // page zoom; only the background worker can ask for it
  const refreshZoom = () => {
    try {
      chrome.runtime.sendMessage({ t: 'zoom' }).then((z) => { if (z > 0) zoom = z; }, () => {});
    } catch { /* extension was reloaded */ }
  };
  const cssPerPoint = () => 1 / (zoom * ((outer === top && top.visualViewport?.scale) || 1));

  // --- Scroll snapping ----------------------------------------------------
  // Snapping would pull every small step to a snap point. Chromium scrolls
  // freely during autoscroll and snaps once when it ends; so switch snapping
  // off on the latched scroller and ease onto the snap point afterwards.
  function unsnap(s) {
    const saved = [];
    for (const el of s.snappers()) {
      unit.settling.get(el)?.();
      if (styleOf(el).scrollSnapType === 'none') continue;
      saved.push([el, el.style.getPropertyValue('scroll-snap-type'),
        el.style.getPropertyPriority('scroll-snap-type'), el.hasAttribute('style')]);
      el.style.setProperty('scroll-snap-type', 'none', 'important');
    }
    return saved;
  }

  // The page gets its own scroll-snap-type back whatever has become of the
  // scroller; easing onto the snap point only makes sense if it is still shown.
  function resnap(s, saved, ease) {
    if (!saved.length) return;
    const off = () => { for (const [el] of saved) el.style.setProperty('scroll-snap-type', 'none', 'important'); };
    const restore = () => {
      for (const [el, value, priority, hadStyle] of saved) {
        try {
          if (value) el.style.setProperty('scroll-snap-type', value, priority);
          else el.style.removeProperty('scroll-snap-type');
          if (!hadStyle && !el.getAttribute('style')) el.removeAttribute('style');
        } catch { /* its frame is gone */ }
        unit.settling.delete(el);
      }
    };
    if (!ease) return restore();
    const at = () => [s.pos('x'), s.pos('y')];
    const apart = (a, b) => Math.abs(a[0] - b[0]) >= 1 || Math.abs(a[1] - b[1]) >= 1;
    const free = at();
    restore();
    s.scrollTo(free[0], free[1], 'instant'); // lands on the snap point Chromium picks from here
    const snapped = at();
    if (!apart(free, snapped)) return;
    off();
    s.scrollTo(free[0], free[1], 'instant');
    s.scrollTo(snapped[0], snapped[1], 'smooth');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.events.removeEventListener('scrollend', arrived);
      restore();
    };
    const arrived = () => { if (!apart(at(), snapped)) finish(); };
    const timer = setTimeout(finish, 1500);
    s.events.addEventListener('scrollend', arrived);
    for (const [el] of saved) unit.settling.set(el, finish);
  }

  // --- Driving a scroller -------------------------------------------------
  // Each frame that latched a scroller moves it from here; the session only
  // says where the pointer is.
  let drive = null;   // { s, tentative, carry, last, snaps }
  let relatch = null; // redoes this frame's latch, should what it knew about its own frame change
  let offSeen = false; // this frame has acted on its unit's scrolling="no"
  let own = null;     // this frame started the session: { gone() }
  let raf = 0;

  function schedule() {
    if (!raf && (own || drive)) raf = outer.requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    const session = unit.session;
    if (!session || (own && own.gone())) return;
    if (drive && alive(drive.s)) {
      // A frame's time is when it began, which can be before a move handled
      // in that same frame started the drive.
      const dt = Math.max(0, Math.min((now - drive.last) / 1000, 0.5));
      drive.last = now;
      const dpr = devicePixelRatio || 1, scale = cssPerPoint() / drive.s.cssZoom();
      const step = (axis) => {
        const v = drive.s.userScrollable(axis)
          ? speed(session.pointer[axis] - session.origin[axis]) * scale : 0;
        // whole device pixels, like the compositor
        const total = v ? drive.carry[axis] + v * dt : 0;
        const whole = Math.trunc(total * dpr) / dpr;
        drive.carry[axis] = total - whole;
        return whole;
      };
      const x = step('x'), y = step('y');
      if (x || y) drive.s.scrollBy(x, y);
    }
    schedule();
  }

  function startDriving(s, tentative) {
    stopDriving();
    drive = { s, tentative, carry: { x: 0, y: 0 }, last: outer.performance.now(), snaps: unsnap(s) };
    schedule();
  }

  function stopDriving() {
    if (!drive) return;
    const { s, snaps } = drive;
    drive = null;
    resnap(s, snaps, alive(s));
  }

  /**
   * Latch a scroller for the direction the pointer went, starting from an
   * element in this unit. The scroll chain may go on in a parent on another
   * origin: `firstBelow` says a frame inside us already has a fallback, and a
   * parent that takes over answers 'driving'.
   * @param {Element} target
   * @param {number} hx -1, 0 or 1
   * @param {number} hy -1, 0 or 1
   * @param {boolean} firstBelow
   * @returns {Scroller | null} what this frame drives
   */
  function latchFrom(target, hx, hy, firstBelow) {
    relatch = () => {
      stopDriving();
      latchFrom(target, hx, hy, firstBelow);
    };
    const { hit, first } = findLatch(scrollChain(target), hx, hy);
    const eats = !!hit && consumes(hit, hx, hy);
    const pick = eats ? hit : firstBelow ? null : first || hit;
    if (pick) startDriving(pick, !eats);
    if (!hit && outer !== top && (sameSiteParent() || !(firstBelow || first))) {
      const { session } = unit;
      askParent({ t: 'bubble', hx, hy, px: session.pointer.x, py: session.pointer.y,
        haveFirst: firstBelow || !!first });
    }
    return pick;
  }

  // The parent can only tell which of its frames is asking from a
  // postMessage; what is asked travels over the extension's own channel.
  function askParent(msg) {
    const session = unit.session;
    if (!session.nonce) {
      session.nonce = token();
      unit.post?.({ [MSG]: session.nonce });
    }
    send({ ...msg, sid: session.id, nonce: session.nonce });
  }

  // --- Cursor -------------------------------------------------------------
  // Chromium's pan cursors, restyled after macOS's own: solid black shapes
  // with a white edge and a soft shadow, no disc. Same 32x32 box and centre
  // hot spot.
  const ANGLE = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
  const arrow = (points, dir) => `<polygon points="${points}" transform="rotate(${ANGLE[dir]} 16 16)"/>`;

  function cursorImage(dirs, axes) {
    const all = axes.x === axes.y; // nothing to scroll gets all four arrowheads too
    const shapes = dirs
      ? `<circle cx="16" cy="16" r="2.6"/>${arrow('16,4.5 10.5,11 21.5,11', dirs)}`
      : `<circle cx="16" cy="16" r="2.6"/>` +
        [...((all || axes.y ? 'ns' : '') + (all || axes.x ? 'ew' : ''))]
          .map((d) => arrow('16,4 11.5,9.5 20.5,9.5', d)).join('');
    return 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">` +
      `<filter id="s" x="-30%" y="-30%" width="160%" height="170%">` +
      `<feDropShadow dx="0" dy="1" stdDeviation="0.9" flood-opacity="0.45"/></filter>` +
      `<g filter="url(#s)" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" paint-order="stroke">` +
      `${shapes}</g></svg>`);
  }

  // A session's cursor travels as a short code, e.g. 'se:11' (arrow, then
  // which axes can scroll) or ':01' (the dead-zone cursor, here with up and
  // down arrowheads).
  const cursorCode = (dirs, axes) => `${dirs}:${+axes.x}${+axes.y}`;

  // Chromium overrides the cursor and leaves the page alone, so hovering and
  // mouse events carry on as usual. A style sheet does the same here: it
  // outranks the page's own cursor rules and is added to the shadow roots the
  // pointer passes through, which a document's sheets don't reach.
  //
  // The price is that every change restyles the whole document. How long
  // that takes depends on the page's CSS far more than on its size (fifty-fold
  // between pages with the same number of elements), so each change is timed,
  // together with the style update the next frame would do anyway. Where it
  // takes longer than SLOW twice in a row, the document gets the layer
  // (below) instead. Such a change freezes the page for several frames (on a
  // 2019 MacBook at 144 Hz, YouTube took 110-205 ms per change, twice per
  // scroll), and with the layer the cursor looks the same; only hover pauses.
  // Twice in a row, because the timings of ordinary pages swing several-fold
  // with whatever else the browser and the machine are doing (one small feed
  // measured 3, 15 and 100 ms within minutes). Until a document has been
  // timed, its size stands in for the time, at what a page with next to no
  // CSS takes: a page of over about 17,000 elements starts on the layer (a
  // plain 15,000-element page measured 44 ms per change).
  //
  // Where a change costs more than CHEAP, a new cursor waits until the
  // direction has held for HOLD, and changes come at least GAP apart: a
  // pointer wavering at the edge of the dead zone would otherwise restyle
  // the page with every twitch. The first cursor of a session and taking it
  // away at the end are never held back. CHEAP leaves headroom over a light
  // page, whose changes measured 4.0-4.2 ms and would otherwise be held back
  // in some sessions and not others.
  const SLOW = 50, CHEAP = 8, HOLD = 120, GAP = 300; // ms
  const MS_PER_ELEMENT = 0.003;
  const ANY = ':is(#mcs#mcs#mcs, *)';
  const sheetRoots = new Set();
  let sheet = null;
  let wanted = ''; // the code last asked for
  let shown = '';  // the code in the sheet
  let way = '';    // how this document shows the session's cursor: 'sheet' or 'layer'
  let cost = null; // ms the last change of the sheet took in this document
  let slow = 0;    // how many changes in a row took longer than SLOW
  let size = 0;    // its element count when that was decided on
  let held = 0;    // timer for a change that waits (see HOLD)
  let changed = 0; // when the sheet last changed
  let plain = false; // this page's CSP refuses data: images; use cursor keywords
  let under = false; // the pointer has been in this document during the session

  function dropSheet() {
    for (const root of sheetRoots) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    sheetRoots.clear();
    shown = '';
  }

  function paintCursor(code) {
    if (code === wanted) return;
    wanted = code;
    clearTimeout(held);
    try {
      if (!code) {
        dropSheet();
        layer?.host.remove();
        layer = null;
        way = '';
        return;
      }
      if (!way) {
        const count = document.getElementsByTagName('*').length;
        if (cost !== null && (count < size / 2 || count > size * 2)) { // a different page by now
          cost = null;
          slow = 0;
        }
        size = count;
        way = (settings.pauseHover || (cost === null ? count * MS_PER_ELEMENT > SLOW : slow >= 2)) ? 'layer' : 'sheet';
      } else if (way === 'sheet' && slow >= 2) {
        // Slower than it looked. Taking the sheet off now spares the end of
        // the session the same pause.
        dropSheet();
        way = 'layer';
      }
      if (way === 'layer') return showLayer(cursorValue(code));
      if (code === shown) return;
      if (shown && cost > CHEAP) {
        const wait = Math.max(HOLD, changed + GAP - performance.now());
        held = setTimeout(() => { if (wanted === code) changeSheet(code); }, wait);
        return;
      }
      changeSheet(code);
    } catch { /* a document that takes no style sheets just keeps its cursor */ }
  }

  function cursorValue(code) {
    const [dirs, axes] = code.split(':');
    const keyword = dirs ? dirs + '-resize' : 'all-scroll';
    return plain ? keyword
      : `url("${cursorImage(dirs, { x: axes[0] === '1', y: axes[1] === '1' })}") 16 16, ${keyword}`;
  }

  function changeSheet(code) {
    try {
      const value = cursorValue(code);
      const start = performance.now();
      sheet ||= new CSSStyleSheet();
      sheet.replaceSync(`${ANY}, ${ANY}::before, ${ANY}::after, ${ANY}::marker, ${ANY}::backdrop,` +
        ` ${ANY}::file-selector-button, :host(${ANY}), ${ANY}::slotted(*) { cursor: ${value} !important; }`);
      shown = code;
      reach(document);
      getComputedStyle(document.documentElement).cursor; // the restyle, now rather than in the next frame
      changed = performance.now();
      cost = changed - start;
      slow = cost > SLOW ? slow + 1 : 0;
    } catch { /* as above */ }
  }

  function reach(root) {
    if (!shown) return;
    sheetRoots.add(root);
    try {
      if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch { /* as above */ }
  }

  // The layer: an empty element over the whole page that carries the
  // cursor, so that a change restyles that one element. The price is that
  // the pointer is over the layer rather than the page while autoscroll
  // runs: the page's hover effects pause, and the mouse events it sees are
  // aimed at the layer. It is shown in the top layer, above dialogs and
  // fullscreen elements.
  let layer = null; // { host, box } while this document shows one

  function showLayer(value) {
    if (layer && !layer.host.isConnected) layer = null; // the page rebuilt its document
    if (!layer) {
      const host = document.createElementNS(XHTML, 'div');
      host.style.cssText = 'all:initial !important; display:block !important; position:fixed !important;' +
        ' left:0 !important; top:0 !important; z-index:2147483647 !important;';
      const box = document.createElementNS(XHTML, 'div');
      box.style.cssText = 'position:fixed; inset:0; width:auto; height:auto; margin:0; padding:0; border:0;' +
        ' background:transparent; overflow:hidden; pointer-events:auto;';
      box.popover = 'manual';
      host.attachShadow({ mode: 'closed' }).append(box);
      document.documentElement.append(host);
      try { box.showPopover(); } catch { /* no top layer here: it stays on top of the page's stacking order */ }
      layer = { host, box };
      if (unit.marker?.host.ownerDocument === document) unit.marker.raise();
    }
    layer.box.style.cursor = value;
  }

  // Plugins and other extensions' frames get no copy of this script, so a
  // click on them would not end autoscroll and the pointer would be lost over
  // them. Chromium routes all mouse input to the autoscrolling page; letting
  // the pointer pass through them has the same effect.
  const OPAQUE = 'embed, object, iframe[src^="chrome-extension:"], iframe[src^="chrome:"]';
  let passed = null; // [element, its own pointer-events...] this session; null until looked for

  function passThrough(on) {
    if (on && !passed && document.documentElement) {
      passed = []; // once per session: a page with none isn't searched again at every change
      for (const el of document.querySelectorAll(OPAQUE)) {
        if (!el.style) continue; // an XML element that only shares the name
        passed.push([el, el.style.getPropertyValue('pointer-events'),
          el.style.getPropertyPriority('pointer-events'), el.hasAttribute('style')]);
        el.style.setProperty('pointer-events', 'none', 'important');
      }
    } else if (!on && passed) {
      for (const [el, value, priority, hadStyle] of passed) {
        if (value) el.style.setProperty('pointer-events', value, priority);
        else el.style.removeProperty('pointer-events');
        if (!hadStyle && !el.getAttribute('style')) el.removeAttribute('style');
      }
      passed = null;
    }
  }

  // Optional marker where the click was, drawn like the dead-zone cursor
  // (Chromium itself only changes the cursor). It is in the top layer too, and
  // goes back above the layer when one is put up after it.
  function placeMarker(e) {
    let { clientX: x, clientY: y } = e;
    for (const w of frames) {
      if (!w.frameElement) break;
      const box = w.frameElement.getBoundingClientRect();
      x += box.left + w.frameElement.clientLeft;
      y += box.top + w.frameElement.clientTop;
    }
    const doc = outer.document;
    const host = doc.createElementNS(XHTML, 'div'); // also in SVG and XML documents
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;';
    const box = doc.createElementNS(XHTML, 'div');
    box.style.cssText = 'position:fixed; inset:0; width:auto; height:auto; margin:0; padding:0; border:0;' +
      ' background:transparent; overflow:visible; pointer-events:none;';
    box.popover = 'manual';
    const img = doc.createElementNS(XHTML, 'img');
    img.src = cursorImage('', { x: true, y: true });
    img.style.cssText = `position:fixed;left:${x - 16}px;top:${y - 16}px;`;
    box.append(img);
    host.attachShadow({ mode: 'closed' }).append(box);
    doc.documentElement.append(host);
    const raise = () => {
      try { box.hidePopover(); } catch { /* not shown yet */ }
      try { box.showPopover(); } catch { /* no top layer here */ }
    };
    raise();
    return { host, raise };
  }

  // --- Sessions -----------------------------------------------------------
  // The unit where the middle button went down owns the session: it runs
  // Blink's state machine
  //   initial (button down, pointer still in the dead zone)
  //   -> holding (moved out while held; release stops)
  //   -> toggled (released in the dead zone; the next press or key stops).
  // Every other unit in the tab joins it as 'remote': it passes on what the
  // pointer, buttons and keys do in its frames, and scrolls if asked to.
  /**
   * @param {{ screenX: number, screenY: number }} e the press (an adopted one
   *   carries only where it was)
   * @param {Element} target what was pressed, or the <iframe> of the child that asked
   * @param {{ v: Scroller | null, h: Scroller | null }} boxes from findBoxes
   * @param {string} [adopted] for a press in a child unit: the nonce of its 'adopt'
   */
  function begin(e, target, boxes, adopted) {
    const id = token();
    const x0 = e.screenX, y0 = e.screenY;
    let { v, h } = boxes;
    let last = { x: 0, y: 0 }, latched = false;
    const far = { x: false, y: false }; // what units outside ours can scroll
    const marker = settings.showMarker && !adopted ? placeMarker(e) : null;
    if (marker) unit.marker = marker;
    const can = (box, axis) => !!box && alive(box) && overflows(box, axis);

    const s = unit.session = {
      id, owner: true, mode: 'initial', cursor: '', nonce: '', frameOff: false, remote: false,
      origin: { x: x0, y: y0 }, pointer: { x: x0, y: y0 },
    };

    // MiddleClickAutoscrollCursor
    const cursor = () => {
      const canV = can(v, 'y') || far.y, canH = can(h, 'x') || far.x;
      const ns = last.y < 0 ? 'n' : last.y > 0 ? 's' : '';
      const ew = last.x < 0 ? 'w' : last.x > 0 ? 'e' : '';
      return cursorCode(canV && ns ? ns + (canH ? ew : '') : canH ? ew : '', { x: canH, y: canV });
    };
    const repaint = () => {
      const code = cursor();
      if (code === s.cursor) return;
      s.cursor = code;
      notify();
      send({ t: 'cursor', sid: id, cursor: code });
    };

    // AutoscrollController::HandleMouseMoveForMiddleClickAutoscroll
    s.move = (px, py, relayed) => {
      if (px === s.pointer.x && py === s.pointer.y) return;
      s.pointer = { x: px, y: py };
      if (s.remote && !relayed) send({ t: 'ptr', sid: id, x: px, y: py });
      if (v && h && alive(v) && alive(h) && !userScrollable(v) && !userScrollable(h)) return s.stop();
      const now = { x: speed(px - x0), y: speed(py - y0) };
      if (now.x === last.x && now.y === last.y) return;
      last = now;
      if (s.mode === 'initial') {
        s.mode = 'holding';
        if (!adopted) unit.voided.add(1);
      }
      repaint();
      // The compositor latches once, on the first move out of the dead zone,
      // from whatever is at the click position by then.
      if (!latched) {
        latched = true;
        const doc = target.ownerDocument;
        const from = target.isConnected ? target
          : adopted ? null
          : deepest(doc.elementFromPoint(e.clientX, e.clientY), e.clientX, e.clientY) || doc.documentElement;
        if (from) latchFrom(from, Math.sign(now.x), Math.sign(now.y), false);
      }
    };

    // AutoscrollController::HandleMouseReleaseForMiddleClickAutoscroll
    s.release = (button) => {
      if (s.mode === 'initial' && button === 1) {
        if (settings.stickyMode) s.mode = 'toggled';
        else s.stop();
      } else if (s.mode === 'holding') {
        s.stop();
      }
    };

    s.joined = (axes) => { // a unit outside ours has started scrolling for us
      s.remote = true;
      far.x ||= axes.x;
      far.y ||= axes.y;
      send({ t: 'ptr', sid: id, x: s.pointer.x, y: s.pointer.y }); // it may have missed moves since it was asked
      repaint();
    };

    // The heartbeat lets frames that turn up later join, and the other units
    // end their part if it stops (this frame torn down, the extension reloaded).
    const beat = setInterval(() => send({ t: 'ping', sid: id, x: x0, y: y0,
      px: s.pointer.x, py: s.pointer.y, cursor: s.cursor }), 1000);

    s.end = () => {
      if (unit.session !== s) return;
      unit.session = null;
      own = null;
      clearInterval(beat);
      marker?.host.remove();
      if (unit.marker === marker) unit.marker = null;
      notify();
    };
    s.stop = () => {
      send({ t: 'stop', sid: id });
      s.end();
    };

    // AutoscrollController::StopAutoscrollIfNeeded: over once its boxes are gone.
    own = {
      gone() {
        if (v && !alive(v)) v = null;
        if (h && !alive(h)) h = null;
        if (v || h) return false;
        s.stop();
        return true;
      },
    };

    // EventHandler::StartMiddleClickAutoscroll invalidates the click. When a
    // plain click starts nothing (hold-only mode) it stays valid until the
    // drag begins; for an adopted press the frame it happened in sees to it.
    if (!adopted && settings.stickyMode) unit.voided.add(1);
    s.cursor = cursor();
    under = !adopted;
    refreshZoom();
    notify();
    send({ t: 'start', sid: id, x: x0, y: y0, cursor: s.cursor, adopted });
    if (outer !== top) askParent({ t: 'hello' });
    schedule();
  }

  // `m` is the session's 'start', or a heartbeat for a unit that missed it.
  function join(m) {
    const s = unit.session = {
      id: m.sid, owner: false, mode: 'remote', cursor: m.cursor, nonce: '', heard: Date.now(),
      origin: { x: m.x, y: m.y }, pointer: { x: m.px ?? m.x, y: m.py ?? m.y },
    };
    const watch = setInterval(() => {
      if (unit.session !== s) clearInterval(watch);
      else if (Date.now() - s.heard > 4000) s.end();
    }, 1500);
    s.move = (px, py, relayed) => {
      if (px === s.pointer.x && py === s.pointer.y) return;
      s.pointer = { x: px, y: py };
      if (!relayed) send({ t: 'ptr', sid: s.id, x: px, y: py });
    };
    s.release = (button) => send({ t: 'up', sid: s.id, button });
    s.end = () => {
      if (unit.session !== s) return;
      unit.session = null;
      notify();
    };
    s.stop = () => {
      send({ t: 'stop', sid: s.id });
      s.end();
    };
    notify();
  }

  // --- What this frame does while a session runs --------------------------
  let live = null; // aborts the listeners that only matter then

  function sync() {
    const session = unit.session;
    if (session && !live) {
      live = new AbortController();
      const during = { capture: true, signal: live.signal };
      addEventListener('mousemove', (e) => {
        const now = unit.session;
        if (!e.isTrusted || !now) return;
        // The cursor is only put where the pointer goes: this document, and
        // the shadow roots under the pointer.
        if (!under) {
          under = true;
          paintCursor(now.cursor);
        }
        reach(document);
        const path = e.composedPath();
        for (const node of path) if (node.nodeType === 11 && node.host) reach(node);
        deepest(path.find((n) => n.nodeType === 1), e.clientX, e.clientY, reach);
        now.move(e.screenX, e.screenY);
      }, { ...during, passive: true });
      // An embedding page has no business reading the cursor (it shows which
      // way the user is scrolling) from frames the pointer is not in.
      addEventListener('mouseout', (e) => {
        if (!e.isTrusted || e.relatedTarget || !unit.session || unit.session.owner) return;
        under = false;
        paintCursor('');
      }, during);
      // Chromium still shows the page the wheel but scrolls nothing with it.
      addEventListener('wheel', (e) => {
        if (e.isTrusted && unit.session && !e.ctrlKey) e.preventDefault();
      }, { ...during, passive: false });
      // Where the page's CSP refuses the cursor images, ask for them once only.
      document.addEventListener('securitypolicyviolation', (e) => {
        if (plain || e.effectiveDirective !== 'img-src' || e.blockedURI !== 'data') return;
        plain = true;
        wanted = shown = '';
        if (unit.session && under) paintCursor(unit.session.cursor);
      }, during);
    } else if (!session && live) {
      live.abort();
      live = null;
    }
    if (!session) {
      under = offSeen = false;
      relatch = null;
      stopDriving();
    }
    paintCursor(session && under ? session.cursor : '');
    try { passThrough(!!session); } catch { /* never worth losing the cleanup above for */ }
  }
  const member = { run: sync, valid };
  unit.sync.set(window, member);
  sync();

  // --- Listeners ----------------------------------------------------------
  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  // document.open() strips every listener from the window and the document,
  // and Chrome doesn't run this script again. What it also does is replace
  // the document's children, so the listeners are put back when that happens
  // (adding one that is still there does nothing).
  // A copy whose extension has been reloaded or removed retires (below) at
  // the first event that reaches any of these listeners.
  const installed = [];
  const on = (target, type, fn, opts) => {
    const handler = (e) => {
      if (valid()) fn(e);
      else retire();
    };
    installed.push([target, type, handler, opts]);
    target.addEventListener(type, handler, opts);
  };
  const rearm = new MutationObserver(() => {
    if (!valid()) return retire();
    for (const [target, type, fn, opts] of installed) target.addEventListener(type, fn, opts);
    if (live) {
      live.abort();
      live = null;
    }
    sync();
  });
  rearm.observe(document, { childList: true });

  // Such a copy can no longer read its settings or reach other frames: it
  // tidies up and leaves the page to the copy injected in its place.
  function retire() {
    unit.session?.end();
    for (const [target, type, fn, opts] of installed) target.removeEventListener(type, fn, opts);
    rearm.disconnect();
    if (unit.sync.get(window) === member) unit.sync.delete(window);
  }

  // Only real input counts; events a page dispatches itself pass through.
  // These listeners are in place before the page's own, so what they swallow
  // the page never sees.
  const listen = (type, fn) => on(window, type, (e) => {
    if (e.isTrusted) fn(e);
  }, true);

  // The press asks for the page zoom too, but the answer comes after the
  // first moves. Only "same speed on every display" needs it then, so with
  // that on it's kept current: a zoom change resizes the viewport.
  let resized = 0;
  on(window, 'resize', () => {
    if (!settings.sameSpeedOnAllDisplays) return;
    clearTimeout(resized);
    resized = setTimeout(refreshZoom, 100);
  });

  // --- Starting and stopping ----------------------------------------------
  // Blink starts autoscroll in the default handler for mousedown: after the
  // page's listeners, and only if none of them called preventDefault(). So a
  // middle press is left alone and decided on once its dispatch is over;
  // meanwhile `pending` keeps up with the pointer.
  let pending = null; // { e, target, x, y }
  let asked = null;   // a parent on another origin was asked to start: { nonce, released }
  const trackPending = (e) => {
    if (pending && e.isTrusted) Object.assign(pending, { x: e.screenX, y: e.screenY });
  };

  function settle() {
    if (!pending || pending.e.eventPhase) return;
    const { e, target, x, y, claimed } = pending;
    pending = null;
    removeEventListener('mousemove', trackPending, true);
    if ((e.defaultPrevented && !claimed) || unit.session || !target || !target.isConnected) return;
    if (styleOf(target).display === 'contents') return; // no box of its own: Blink starts nothing
    if (settings.linksOpenTabs && onLink(target)) return;
    const boxes = findBoxes(target);
    if (boxes) {
      begin(e, target, boxes);
      unit.session?.move(x, y);
    } else if (outer !== top && sameSiteParent()) {
      // Nothing to scroll in here, but in one process Blink would go on
      // looking in the page around the frame.
      const nonce = token();
      asked = { nonce, released: false };
      setTimeout(() => { if (asked?.nonce === nonce) asked = null; }, 2000);
      unit.post?.({ [MSG]: nonce });
      send({ t: 'adopt', nonce, x: e.screenX, y: e.screenY, px: x, py: y });
    }
  }

  // Chrome on Windows starts its own autoscroll from a middle press that is
  // still not default-prevented when its dispatch is over. Where this one is
  // used instead, it claims the press last, after the page's own listeners
  // have had their say (Chrome's own autoscroll doesn't start on links).
  if (BUILT_IN_AUTOSCROLL) {
    on(window, 'mousedown', (e) => {
      if (!e.isTrusted || pending?.e !== e || e.defaultPrevented) return;
      if (settings.linksOpenTabs && onLink(pending.target)) return;
      pending.claimed = true;
      e.preventDefault();
    }, false);
  }

  // Asking the parent has to be over before the click that follows the press,
  // which a background worker that is asleep can't manage. In the few frames
  // that may have to ask, wake it as the pointer comes in.
  if (outer !== top && sameSiteParent()) {
    on(window, 'mouseover', (e) => {
      if (e.isTrusted && !e.relatedTarget) send({ t: 'wake' });
    }, true);
  }

  // EventHandler::HandleMousePressEvent: any press ends autoscroll, and the
  // press itself goes nowhere.
  listen('pointerdown', (e) => {
    settle();
    if (unit.session) e.stopImmediatePropagation();
  });

  listen('mousedown', (e) => {
    settle();
    if (unit.session) {
      swallow(e);
      unit.voided.add(e.button);
      unit.session.stop();
      return;
    }
    unit.voided.delete(e.button);
    if (e.button !== 1 || isOff()) return;
    pending = { e, target: deepTarget(e), x: e.screenX, y: e.screenY };
    addEventListener('mousemove', trackPending, true);
    setTimeout(settle, 0);
  });

  // The page gets its mouseup, as in Chromium, but not the click after it.
  listen('mouseup', (e) => {
    settle();
    if (asked) asked.released = true;
    if (unit.voided.has(e.button)) setTimeout(() => unit.voided.delete(e.button), 0);
    unit.session?.move(e.screenX, e.screenY);
    unit.session?.release(e.button);
  });

  const voidClick = (e) => {
    if (e.detail && unit.voided.delete(e.button)) swallow(e);
  };
  listen('click', voidClick);
  listen('auxclick', voidClick);

  // KeyboardEventManager::KeyEvent: a key press ends autoscroll, and no key
  // event reaches the page while it runs.
  listen('keydown', (e) => {
    settle();
    if (!unit.session) return;
    swallow(e);
    unit.session.stop();
  });
  listen('keyup', (e) => {
    if (unit.session) swallow(e);
  });

  // FocusController::FocusHasChanged: over when the page loses focus. Only
  // the top document can tell that from focus moving between frames.
  const stopIfUnfocused = () => setTimeout(() => {
    if (!top.document.hasFocus()) unit.session?.stop();
  }, 0);
  on(window, 'blur', (e) => {
    if (!e.isTrusted || e.target !== window || !unit.session) return;
    if (outer === top) stopIfUnfocused();
    else send({ t: 'blur', sid: unit.session.id });
  });

  // Page::SetVisibilityState: over when the tab is hidden. A document that is
  // being unloaded reports itself hidden too; that one frame going away is
  // no reason to stop.
  let leaving = false;
  on(document, 'visibilitychange', (e) => {
    if (e.isTrusted && document.hidden && !leaving) unit.session?.stop();
  });
  on(window, 'pagehide', (e) => {
    if (!e.isTrusted) return;
    leaving = true;
    // The session goes with the frame that started it, and with its unit's
    // outer frame (which may come back from the back/forward cache).
    const session = unit.session;
    if (session && (own || window === outer)) {
      if (session.owner) session.stop();
      else session.end();
    }
    stopDriving();
    if (unit.sync.get(window) === member) unit.sync.delete(window);
  });
  on(window, 'pageshow', (e) => {
    if (!e.isTrusted) return;
    leaving = false;
    unit.sync.set(window, member);
    sync();
  });

  // --- Other units --------------------------------------------------------
  // A child unit introduces itself with a postMessage carrying a nonce (that
  // tells us which window it is) and asks over the extension channel. Only
  // then is its <iframe> looked for, so that a page can't make us search the
  // document by posting messages.
  function frameOf(source) {
    const search = (root) => {
      for (const el of root.querySelectorAll('iframe, frame, object, embed')) {
        if (el.contentWindow === source) return el;
      }
      for (const el of root.querySelectorAll('*')) {
        const inner = shadowOf(el);
        const found = inner && search(inner);
        if (found) return found;
      }
      return null;
    };
    return search(document);
  }

  on(window, 'message', (e) => {
    if (e.ports.length !== 1 || !e.source || e.source === window) return;
    const nonce = e.data && e.data[MSG];
    if (typeof nonce !== 'string') return;
    e.stopImmediatePropagation();
    // one entry per child window, so that none can push the others out
    for (const [key, entry] of unit.nonces) if (entry.source === e.source) unit.nonces.delete(key);
    if (unit.nonces.size >= 32) unit.nonces.delete(unit.nonces.keys().next().value);
    unit.nonces.set(nonce, { source: e.source, win: window, frame: null });
    for (const key of [...unit.waiting.keys()]) {
      if (!key.startsWith(nonce + ':')) continue;
      const m = unit.waiting.get(key);
      unit.waiting.delete(key);
      fromChild(m);
    }
  }, true);

  function fromChild(m) {
    const entry = unit.nonces.get(m.nonce);
    if (!entry) {
      if (unit.waiting.size > 16) unit.waiting.clear();
      unit.waiting.set(m.nonce + ':' + m.t, m);
      return;
    }
    if (entry.win !== window) return;
    try {
      entry.frame ||= entry.source.parent === window ? frameOf(entry.source) : null;
    } catch { /* that window is gone */ }
    const frame = entry.frame;
    if (!frame || !frame.isConnected) return;
    const session = unit.session;
    if (m.t === 'adopt') {
      if (session || isOff()) return;
      const boxes = findBoxes(frame);
      if (boxes) {
        begin({ screenX: m.x, screenY: m.y }, frame, boxes, m.origin || m.nonce);
        unit.session?.move(m.px, m.py);
      } else if (outer !== top && sameSiteParent()) {
        // nothing here either: on to the page around this frame
        const nonce = token();
        unit.post?.({ [MSG]: nonce });
        send({ ...m, nonce, origin: m.origin || m.nonce });
      }
    } else if (session?.id !== m.sid) {
      return;
    } else if (m.t === 'hello') {
      send({ t: 'frame', sid: m.sid, nonce: m.nonce,
        off: /^(no|off|noscroll)$/i.test(frame.getAttribute('scrolling') || '') });
    } else if (m.t === 'bubble' && !drive) {
      session.move(m.px, m.py, true);
      refreshZoom();
      const pick = latchFrom(frame, m.hx, m.hy, m.haveFirst);
      if (pick) send({ t: 'driving', sid: m.sid, nonce: m.nonce, x: overflows(pick, 'x'), y: overflows(pick, 'y') });
      if (outer !== top && !session.nonce) askParent({ t: 'hello' }); // is our own frame scrolling="no"?
    }
  }

  chrome.runtime.onMessage.addListener((m) => {
    const session = unit.session;
    const mine = !!session && session.id === m.sid;
    switch (m.t) {
      case 'start':
        // A press somewhere started this; it also ends whatever ran before.
        if (session && !mine) {
          if (session.owner) session.stop();
          else session.end();
        }
        if (!unit.session && window === outer) join(m);
        if (m.adopted && m.adopted === asked?.nonce) {
          unit.voided.add(1);
          if (asked.released) send({ t: 'up', sid: m.sid, button: 1 });
          asked = null;
          under = true; // the pointer is in here: show the cursor without waiting for it to move
          if (unit.session) sync();
        }
        break;
      case 'ping':
        if (mine) {
          session.heard = Date.now();
        } else if (window === outer && (!session || (!session.owner && Date.now() - session.heard > 2000))) {
          // this unit turned up after the session began, or is in one that died
          session?.end();
          join(m);
        }
        break;
      case 'cursor':
        if (mine && !session.owner && session.cursor !== m.cursor) {
          session.cursor = m.cursor;
          notify();
        }
        break;
      case 'ptr':
        if (mine) session.move(m.x, m.y, true);
        break;
      case 'up':
        if (mine && session.owner) session.release(m.button);
        break;
      case 'stop':
        if (mine) session.end();
        break;
      case 'blur':
        if (mine && window === top) stopIfUnfocused();
        break;
      case 'frame':
        if (!mine || session.nonce !== m.nonce || !m.off) break;
        session.frameOff = true;
        // The answer can come after the latch, which then counted on a
        // viewport the user can't scroll: latch again.
        if (!offSeen) {
          offSeen = true;
          relatch?.();
        }
        break;
      case 'driving':
        if (!mine) break;
        if (session.owner) session.joined(m);
        // In one process the scroller outside would be the only one latched.
        if (drive?.tentative && sameSiteParent()) stopDriving();
        break;
      case 'hello':
      case 'bubble':
      case 'adopt':
        fromChild(m);
        break;
    }
  });
})();
