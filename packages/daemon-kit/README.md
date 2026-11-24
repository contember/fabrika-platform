# @fabrika/daemon-kit

Bun daemon infrastructure without canvas or browser dependencies:

- `createNotificationChannel`, `browserFrame`: topic-based WebSocket routing.
- `waitForEvent`, `WaitError`: CLI waiting, reconnects and deadlines.
- `createDaemonLifecycle`, `DaemonStartError`, `DaemonStopError`: process startup, health and shutdown.
- `dispatch`, `Route`: HTTP routing.
- `jsonResponse`, `corsHeaders`: HTTP response helpers.
- `createCapability`, `writeCapabilityFile`, `readCapabilityFile`, `matchesCapability`: the CLI capability a daemon
  writes for its owner (`0600` in a `0700` directory) and checks in constant time on the routes only its CLI calls.
- `userRuntimeDir`, `ensureRuntimeDir`: a host's per-user runtime directory, `$XDG_RUNTIME_DIR/<app>` or
  `<tmpdir>/<app>-<uid>`, created `0700`; a symlink, a file or another user's directory there is refused.
- `uiCookieName`, `hasUiCookie`, `UiLinks`, `openLinkResponse`, `uiPage`, `withoutCookies`, `openLinkThroughFile`: a
  browser UI's credential. A secret each daemon start makes afresh (`createCapability`, held in memory only), held by
  the browser as an `HttpOnly; SameSite=Strict` cookie named after the port; one-time links with a destination the daemon chose,
  which `/open` trades for the cookie through a page that refreshes; and the CLI side, which hands the browser such a
  link through a `0600` file, never as a process argument. The daemon supplies its cookie prefix and its pages.
- `openerAllowed`, `TEST_OPENER_DIR_VARIABLE`: what a CLI's browser opener asks before it runs. Under a test run
  (`NODE_ENV=test`) only an opener inside `FABRIKA_TEST_OPENER_DIR`, the test's own fake, runs; without it the CLI
  prints the URL. `bun test` sets `NODE_ENV=test` only when it is unset, so a test helper that spawns a CLI sets it
  explicitly; then that test never opens the user's real browser.
- `@fabrika/daemon-kit/ui-client` `reconnectOrReload`: a UI whose socket dropped reloads when the daemon answers 401, so
  the browser shows the daemon's page that names the command for a fresh link. It imports no runtime of the daemon.

Import runtime functions and types from `@fabrika/daemon-kit`.
The host supplies its domain-specific frame vocabulary and persistence.
Canvas session/compile/upload paths remain in `@fabrika/canvas-kernel/server`.
