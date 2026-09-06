# Widget browser checks

Run `npm run test:browser` from the repository to execute all three checks
sequentially (general, gestures, menus). Set `CHROME_BIN` if Chrome is installed
somewhere other than `/usr/bin/google-chrome`.

Run `node tests/browser/widget-pinning.js` for the general widget check alone.

Run `node tests/browser/widget-pinning.js --gestures` for the regression check
with the app iframe served from a different site (`localhost` vs `127.0.0.1`).
It uses an iframe-local gesture client and asynchronous messages to reproduce
Chromium's frame routing, then checks longpress → release → immediate drag near
the top, upward movement and release outside the widget. It also checks the
button interiors and actual touch activation in compact/wide/tall widgets.

Run `node tests/browser/widget-pinning.js --menus` to check compact menus with
Portuguese labels and the app's CSS reset at desktop and phone viewport widths.
It samples every frame during opening/reopening near the edges, checking natural
label/icon sizes and a stable first visible position, with and without CSS anchors.

The runner uses a temporary Chrome profile and local fixtures. It bundles the
actual widget grid, controls, menu, injected gesture client, storage operations
and metadata hooks, and reads the screen/background CSS from the source.
External app loading, the network bridge and permission dialogs are substituted.
The check is separate from `npm test`, which does not require a browser.

Coverage includes pin precedence and hit testing, native popover/modal layers,
compact controls and menu positioning with/without CSS anchors, selection timeout,
automatic/manual reveal, ownership transfer, iframe/document continuity, resize
on all four edges, mouse and emulated touch drag, free-area swipe, page clipping,
edge page switching, hidden-tab/workspace cleanup and cross-tab metadata updates.

Physical Chrome Android and Firefox Android validation remains necessary for
device-specific longpress feedback and gesture behavior. Chrome touch emulation
does not certify either mobile browser. Safari/iPhone is outside this acceptance
pass.
