<p align="center">
  <img src="extension/icons/icon128.png" width="96" height="96" alt="">
</p>

<h1 align="center">Middle Click Autoscroll Chrome Extension</h1>

<p align="center">Windows-style middle-click autoscroll for Chrome on macOS.</p>

Middle click to move the pointer to scroll; the further you move, the faster
it goes. Click again or press any key to stop, or hold the button, drag and
release.

Chrome has this built in, but on macOS it's switched off. The only way to turn
it on is launching Chrome from Terminal with an unsupported flag, every time:

```sh
open -a "Google Chrome" --args --enable-blink-features=MiddleClickAutoscroll
```

This extension attempts to replicate the behaviour of Chromium's own
implementation: the same speed curve, dead zone, choice of what scrolls, and
ways to stop.

## Installation

1. Download or clone this folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select the `extension` folder.

Requires Chrome 119 or later.

## Usage

| Action | Result |
|---|---|
| Middle-click, then move | Scrolls until you click or press a key |
| Hold the middle button and drag | Scrolls until you release |
| Middle-click on a link | Opens it in a new tab, as usual |
| Wheel while autoscrolling | Ignored, as in Chrome on Windows |
| Switching tab or app | Stops it |

The cursor shows which way the page can scroll. Speed and dead zone scale with
page zoom, as in Chrome. Chrome also scales them with the display, so a
standard display scrolls about 4.6 times faster than a Retina one for the same
hand movement; the extension doesn't by default ("Same speed on every display"
is on), and turning that option off gives Chrome's behaviour.

Options, under the toolbar icon: speed, acceleration curve and dead zone; the
same speed on every display; click-to-toggle or hold-only; a marker at the
click point; whether middle-clicking a link opens it or autoscrolls; pausing
hover effects while autoscrolling, which can make busy pages smoother; and
sites to disable (subdomains included).

## How it works

Chrome's own autoscroll runs inside the browser: it scrolls on the compositor
thread and sets the cursor directly. An extension can do neither, so this one
works from inside the page.

- **Scrolling.** A script moves the scroller every frame, choosing it the way
  Chrome does across nested scrollers, iframes and shadow DOM. The ext runs on the
  page's main thread (unavoidable unfortunately), so busy pages can stutter where Chrome's own implementation stays
  smooth.
- **Cursor.** A style sheet gives every element the autoscroll cursor, so
  hovering and clicking keep working. Each cursor change restyles the whole
  page, so the extension times it. Where two changes in a row take over
  50 ms (busy sites like YouTube or twitter on slower Macs, long Wikipedia articles, the
  single-page HTML standard), it puts the cursor on an invisible layer instead: hover
  effects pause while scrolling, and mouse events go to the layer. Where a
  change costs more than 8 ms, a new cursor waits until the direction has
  held for 120 ms. "Pause hover effects" uses the layer on every page. 
  Its likely that most apple silicon macs wont suffer from due to their better single threaded and gpu performance compared to older intel macs. 
- **The page.** Without the layer, it gets the same mouse and keyboard events
  as with Chrome's own autoscroll. It can block autoscroll by cancelling the
  middle press, and gets back anything the extension changed, such as scroll
  snapping.
- **Frames.** Frames from other sites coordinate through the background
  worker, so autoscroll carries on across them and a click in any of them
  stops it.

## Limitations

- Doesn't run on Chrome's own pages, the Web Store, other extensions' pages or
  the PDF viewer. Local files need "Allow access to file URLs".
- Can't pan a pinch-zoomed page.
- Two Chrome behaviours are deliberately left out: at page zoom other than
  100% Chrome can latch onto the wrong element, and at very large scroll
  offsets its autoscroll can stop responding.
- Only tested on macOS, though it probably works on Linux and ChromeOS aswell. On Windows, where Chrome's own autoscroll is on, the
  extension turns off by default unless you switch it on in the popup.

## Permissions

| Permission | Why |
|---|---|
| Access to all sites | The script has to run on any page you might scroll |
| `scripting` | Adds the script to tabs already open at install, so it works without reloading them |
| `storage` | Saves your options |
| `activeTab` | Lets the popup show whether the current site is enabled |

The extension collects nothing and makes no network requests.

## Development

| Path | Contents |
|---|---|
| `extension/` | The extension itself, as loaded by Chrome |
| `extension/autoscroll.js` | The content script: everything that happens on a page |
| `extension/background.js` | Relays messages between frames, reports page zoom, updates open tabs |
| `extension/defaults.js` | Default settings and the speed constant |
| `extension/options.html`, `options.js` | The toolbar popup and options page |
| `export.sh` | Builds the Web Store upload |
| `tools/strip-comments.py` | Takes the comments out of the code for the upload |

`./export.sh` zips `extension/` into `dist/middle-click-autoscroll-<version>.zip`,
with the comments taken out of its scripts, page and styles (the code is
otherwise unchanged).
It refuses if `extension/` has uncommitted changes or the version was already
exported; `--force` skips both checks.

## License

MIT, see [LICENSE](LICENSE). If you want to publish your own modified version, please give it a
different name and icon.
