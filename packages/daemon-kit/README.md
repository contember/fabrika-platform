# @fabrika/daemon-kit

Bun daemon infrastructure without canvas or browser dependencies:

- `createNotificationChannel`, `browserFrame`: topic-based WebSocket routing.
- `waitForEvent`, `WaitError`: CLI waiting, reconnects and deadlines.
- `createDaemonLifecycle`, `DaemonStartError`, `DaemonStopError`: process startup, health and shutdown.
- `dispatch`, `Route`: HTTP routing.
- `jsonResponse`, `corsHeaders`: HTTP response helpers.
- `createCapability`, `writeCapabilityFile`, `readCapabilityFile`, `matchesCapability`: the CLI capability a daemon
  writes for its owner (`0600` in a `0700` directory) and checks in constant time on the routes only its CLI calls.

Import runtime functions and types from `@fabrika/daemon-kit`.
The host supplies its domain-specific frame vocabulary and persistence.
Canvas session/compile/upload paths remain in `@fabrika/canvas-kernel/server`.
