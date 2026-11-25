---
id: 0087
title: An SPA mount is installable as an application, under its own access
status: proposed
date: 2026-11-25
---

# 0087: An SPA mount is installable as an application, under its own access

## Context

People who use a Fabrika application every day want it in its own window and on their phone's home screen, not as
one tab among many. A browser installs a site as an application (a "progressive web app") from a **web app manifest**:
a JSON document the page links, naming the application, its icons, its colours, its start URL and its scope. Today no
application ships one, and asking each author to write one gives every application a different, partly broken one. The
platform knows everything a manifest says: the contract's id and `displayName`, each SPA mount's prefix.

What already holds and must keep holding:

- **The proxy is the only enforcement point** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)). Every
  file of a credentialed SPA mount, its built assets included, is served only to a request whose session or key the
  endpoint admits. A navigation without one is a 302 to IAM's sign-in, any other request a 401 carrying `loginUrl`.
- **Every answer is `Cache-Control: no-store`, static assets included** (ADR-0022 rule 2). Nothing of an application
  is meant to outlive a revoked session in a cache the platform does not control.
- **An SPA mount already answers framework files under its prefix and its own access:** `__fabrika-config.json` and
  `__fabrika-me.json` ([ADR-0012](0012-fabrika-app-runtime.md)). The framework answers them in `dispatch.ts` before the
  asset server, on Bun and in the Cloudflare object alike, so they need no provider code.
- **The protocol between an application and the platform must not break** inside the support window
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)). A new row kind, a new manifest field or a
  new header reaches older proxies only through a capability marker per provider.

The facts about browsers that decide the shape, as checked on 2026-11-25:

1. **A browser fetches a manifest with CORS, and its credentials follow the link's `crossorigin` attribute** (HTML,
   link type `manifest`). Chromium 157 fetched a manifest linked without the attribute without the session cookie,
   although it lay on the page's own origin. With `crossorigin="use-credentials"` it sent the cookie on the manifest
   **and** on the icon it then fetched from it. Checked against a local server that refused
   every request without a cookie, through agent-browser's Chromium. Not checked: Safari on macOS and iOS, Firefox,
   Chromium on Android.
2. **Chrome installs a site from its menu without a service worker** since Chrome 108 on Android and 112 on desktop
   ([Chrome for Developers](https://developer.chrome.com/blog/update-install-criteria)). Its criteria are a manifest
   with a name, 192 px and 512 px icons, a start URL and a `display` of `standalone` (or `fullscreen`, `minimal-ui`).
   Whether Chrome's automatic install prompt still needs a worker with a `fetch` handler is not settled in its own
   documentation. Safari's "Add to Dock" (macOS) and "Add to Home Screen" (iOS) need no worker.
3. **A manifest is only ever fetched by a page that links it.** An installed application that opens with an expired
   session navigates to its start URL. That is a navigation like any other: the proxy bounces it to IAM's sign-in,
   which the browser shows inside the application's window with IAM's origin named, because IAM's origin lies outside
   the manifest's scope. The callback returns to the application's host, back in scope, and only the page that then
   loads fetches the manifest again, with the session.

## Decision

**We will make every credentialed SPA mount installable as an application, from a manifest and an icon the framework
derives from the approved contract and serves under the mount's own access, like `__fabrika-config.json`. Nothing
becomes public, the proxy table does not change, and no service worker is installed yet.**

1. **The framework serves the manifest and the icons under the mount.** A credentialed `c.spa` mount (access
   `member`, an action, or `app`) answers `<prefix>/__fabrika-app.webmanifest` (`APP_MANIFEST_FILE`) and
   `<prefix>/__fabrika-icon-<180|192|512>.png` (`appIconFile`) itself, before the asset server, in
   `packages/app/src/implement/installable.ts`. They are paths of the mount's own row: the proxy decides them as it
   decides the mount's pages, and the answers carry the header policy of every other answer, `no-store` included. An
   application's own files at those names are never served. **No other endpoint may take one of these paths:**
   `buildArtifact` plans a `GET` of each file an SPA mount serves (`spaMountFiles`: the browser config and the caller
   document of every mount, the installable files of a credentialed one) and refuses the contract when the selected row
   is not the mount's, because a more specific row (a health endpoint or a webhook at
   `/admin/__fabrika-app.webmanifest`, a public procedure's own path under the root SPA) would take the request under
   its own rules and the page would link that endpoint's answer.
2. **The manifest is derived, never authored.** `name` is the contract's `displayName`, or its id; a mount below the
   root appends its own name (`Orders · admin`). `short_name` of the root mount is the name when it has at most 12
   characters, else its first word when that fits, else its first 12 characters; below the root it keeps the mount, so
   two mounts never show the same one: the name and the mount, else its first word and the mount (`Orders admin`), else
   the mount alone. `id`, `start_url` and `scope` are the mount itself (`<prefix>/`). Below the root that keeps an
   installed window to the mount's pages; the root mount's scope `/` covers the whole host, its other mounts included,
   and a nested mount's prefix lies inside its parent's scope. A scope cannot exclude a path, so this is documented,
   not prevented: the installed window treats those pages as its own, and the proxy still decides every request.
   `display` is `standalone`. `theme_color` and `background_color` are the mount's colour (below). The icons are the
   192 px and 512 px PNGs, and the 512 px one again as `maskable`.
3. **The icon is drawn by the framework.** It is the mount's colour edge to edge, with the name's first letter or digit
   (diacritics removed) in white at its centre, drawn from a fixed 5×7 glyph inside the circle a maskable icon keeps
   visible. The colour is a hue at a fixed saturation and lightness: for the root mount, FNV-1a of the application
   id; below the root, that hue turned by 90° to 270°, picked by FNV-1a of the mount's name. So it is stable across
   releases, differs between applications, and a mount is always at least 90° of hue from its application's root
   mount: two hues hashed independently can land a few degrees apart and look the same. It is encoded as a PNG with
   `CompressionStream`, which Bun and workerd both provide, once per runtime and size.
4. **The mount's pages link them with the session.** Every HTML answer of the mount gets, at the start of its head,
   `<link rel="manifest" href="<prefix>/__fabrika-app.webmanifest" crossorigin="use-credentials">` and
   `<link rel="apple-touch-icon" href="<prefix>/__fabrika-icon-180.png">`, through the one injection the share
   bootstrap uses (`html.ts`). The start of the head is read from the document's opening only: after the `<head>`
   start tag, or, where the document omits it (HTML allows that), after the DOCTYPE and the `<html>` start tag, never
   before the DOCTYPE, which would switch the page to quirks mode. The link comes first in the head, so where a page
   links a manifest of its own, the browser uses the platform's.
5. **A public SPA mount and a link mount are not installable.** A public mount is a site anyone opens (a form, an
   identification page); a link mount is a page opened from a share link. Neither serves the files nor gets the links.
6. **No service worker, and no answer of the application is cached.** The platform installs no worker in this
   decision, and every answer stays `no-store`. What an installed application does keep on the device is its manifest
   and its icons (its name and colour), which the browser or the operating system holds past a sign-out or a
   revocation; they carry nothing the sign-in page does not show, and every request still meets the proxy. When a
   worker comes (with Web Push, below), it is a fixed script the platform writes, it caches no answer of the
   application, and it never holds or forwards a credential.

## Consequences

- **Every member application can be installed** on Chrome and Edge from the address bar or the menu, and through
  Safari's "Add to Dock" and "Add to Home Screen", without its author doing anything. Each mount of an application is
  its own installable application, with its own name, colour and scope. Mounts are separate installed windows only
  where their prefixes do not nest: the root mount's window also opens the other mounts' pages, and a browser may open
  a link to one of them in the root application. An author who wants separate windows gives every mount its own prefix.
- **Nothing is public that was not.** The manifest and the icons say no more than the sign-in page already does (the
  application's name), and they are refused to a visitor without a session like every other file of the mount.
- **The access surface does not change.** No row, no row kind, no manifest field and no header is added, so the
  contract digest, every approval and every proxy of every provider stay as they are. There is no provider code:
  Zerops, Cloudflare and AWS serve it through the same dispatcher.
- **An application meets it when it raises its `@fabrika/app` pin.** It is framework behaviour, not platform protocol
  (ADR-0062). The rollout path of an existing installation is empty: no generated file, environment variable or
  provider state changes, and `fabrika platform upgrade` has nothing to converge.
- **A session that expired while the application was closed is a sign-in inside its window.** The start URL's
  navigation is bounced to IAM like any other, and IAM's page is out of scope, so a browser shows its origin above it.
  The handoff (ADR-0022 rule 4, [ADR-0023](0023-one-session-per-host.md)) runs in the same window and the same cookie
  jar, so it completes there. This holds for Chromium's installed windows; iOS differs (next item).
- **On iOS, the sign-in after an expired session is unverified and may fail closed.** What is reported, not yet
  checked on a device: an iOS Home Screen application has a cookie jar of its own, separate from Safari's (since iOS
  17.2 it starts with a copy of Safari's cookies, then diverges), and it opens a navigation outside its scope, such as
  IAM's sign-in, in a Safari View Controller sheet over its window. Older reports (iOS 12.2) say a redirect back into
  the scope closes the sheet and loads the page in the application's window; recent ones say the redirect can stay in
  the sheet or end in Safari. The flow then runs like this. The start URL's 302 sets the handoff verifier in the
  application's own jar. IAM's sign-in happens in the sheet, and IAM's own session cookie stays wherever the sheet
  keeps it. The callback on the application's host redeems the code only where the verifier is. If it loads in the
  application's window, the session cookie is set in the application's jar and the person is in. If it stays in the
  sheet or in Safari, the verifier is missing and the proxy refuses the callback with its failed sign-in page: the
  person is stuck outside the application, and no session reaches a jar that did not start the sign-in. Either way
  nothing weakens: ADR-0023's binding is what turns the wrong jar into a refusal. If a device check shows the
  refusal, the fix belongs in the sign-in flow (for example a sign-in the application's window opens itself), not in
  the manifest.
- **An installed application works only online.** With no worker, an offline launch shows the browser's own offline
  page. Every answer needs the network anyway: the data is behind the proxy and `no-store`.
- **The page's HTML is rewritten** on every mount, as the share bootstrap already is for a link mount, and the share
  bootstrap now goes to the same place: after the DOCTYPE in a page without a `<head>` tag, where it used to go before
  it. A fragment without a DOCTYPE gets the links at its very start.
- **A contract that puts another endpoint on one of a mount's own files no longer compiles** (Decision 1). Before, the
  more specific row silently answered there; for `__fabrika-config.json` and `__fabrika-me.json` too. The refusal names
  the path and the endpoint that takes it.
- The pixel glyph is a default, not a brand: an author's own icon is an open question below.

## Alternatives considered

- **Serve the manifest, the icons and a worker on public paths the proxy lets through without a session.** This was
  the first proposal: fixed `/__fabrika/…` paths as a canonical anonymous row that platform composition adds to every
  application's table, like the ops row ([ADR-0069](0069-control-reaches-an-application-environments-object.md)).
  Rejected for now: it widens every application by an anonymous row that reaches its process, it needs the row in the
  contract artifact or a new composed form (an approval for every application, or a strict-parser change and a
  capability marker on each provider, Cloudflare included), and it buys nothing a browser needs, because a manifest is
  fetched only by a page that has just loaded under a session (fact 3) and Chromium sends that session when the link
  asks for it (fact 1). It stays the fallback if a browser we must support refuses to send the cookie for the manifest
  or its icons.
- **Let the proxy answer the files itself, from fields of its manifest.** Rejected: it adds a manifest field that every
  older proxy's strict parser refuses (so a capability marker per provider), it puts the icons into every proxy's
  manifest, Cloudflare's included ([ADR-0066](0066-the-installation-shows-its-clients-logo.md) met the same limit with
  the client's logo), and the proxy would gain content it serves with no decision to make.
- **Let each author write the manifest and draw the icons.** Rejected: most would not, and those who did would differ
  in scope, start URL and credentials, and an omitted `crossorigin="use-credentials"` fails silently (fact 1). The
  platform has every fact the manifest needs.
- **Opt in per mount, behind a contract flag defaulting off.** Rejected: an option of `c.spa` is part of the contract
  the static reader reads (ADR-0005), and the change makes nothing public that needs a choice. A way to turn it off is
  an open question.
- **A service worker that caches the application shell now.** Rejected: ADR-0022 makes every answer `no-store` so that
  nothing outlives a revoked session, a cached shell is stale after a deploy whose hashed assets it no longer names,
  and installability does not need it (fact 2).
- **A native shell now (Electron, Tauri, a menu bar application).** Rejected for now: it is a separate distributable
  per operating system, with its own update channel, signing and credential store, for what a browser's installed
  window already gives. A menu bar presence is out of scope until Web Push shows what is missing.

## Open questions

- **Safari, Firefox and Android.** Does Safari on macOS and iOS send the session for a `use-credentials` manifest and
  for `apple-touch-icon`? On iOS, does the callback after IAM's sign-in load in the application's window (signed in)
  or stay in the Safari View Controller sheet (the refused callback above)? Does Chromium on Android mint its installed
  package with the session? Each needs a check on a device; a browser that refuses the cookie for a file would bring
  back the public-path alternative for that file alone.
- **Web Push** is [ADR-0088](0088-a-push-says-only-that-something-happened.md): an empty push, a platform worker at
  `/__fabrika/push/worker.js` that controls no page and caches nothing, the text read under the session, and the
  subscriptions in the application's own database.
- **An author's own icon and name.** A `c.spa` option naming an image of the mount's build (PNG, at least 512 px), and
  a display name per mount, both read by the static reader; until then the drawn icon and the derived name stand.
- **Turning it off.** An application that must not be installable (a kiosk page) needs a way out, most likely the same
  `c.spa` option.
- **Chrome's automatic install prompt.** If it still requires a worker with a `fetch` handler, the address bar's install
  button and the menu remain, which is enough; a `fetch` handler that only passes requests through is not added for the
  prompt's sake.
