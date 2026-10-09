# @fabrika/builder

`@fabrika/builder` guides a coding agent from an initial application brief to a reviewed acceptance contract and an assisted implementation.

The builder runs eight deterministic phases:

1. intake
2. vision
3. flows
4. technology
5. design
6. opice test skeletons
7. implementation issues
8. build

The current phase is derived from files in `.fabrika/`; it is not stored as a mutable counter. Review gates use a local dashboard with persistent annotations and responses.

## Usage

Install the public CLI and initialize the builder in an application repository:

```bash
bun add --global @fabrika/cli
fabrika builder init
```

Initialization installs the Fabrika skill and the `fabrika-app` application rules (from `@fabrika/app`) for Claude Code and Codex, starts the local daemon, and opens the dashboard. The coding agent then drives the phase loop.

```text
fabrika builder next
do the emitted work
fabrika builder gate open <phase> --view <canvas.jsx>
fabrika builder gate wait
fabrika builder advance
```

All commands:

```text
fabrika builder init [dir] [--profile <stack>] [--agent all|claude|codex]
fabrika builder init [dir] --url=<control-origin>
fabrika builder connect --url=<control-origin> [--no-open] [--json]
fabrika builder status [--json]
fabrika builder disconnect [--json]
fabrika builder deploy [--wait] [--timeout=<seconds>] [--json]
fabrika builder preview --url=<preview-url>
fabrika builder preview --clear
fabrika builder next [--json]
fabrika builder advance [--force]
fabrika builder gate open <name> --view <file.jsx>
fabrika builder gate wait [--gate <revision>] [--timeout <ms>]
fabrika builder ensure-daemon
fabrika builder induce [--force]
fabrika builder build [--issue <ID>] [--assisted]
```

Use `--profile cf-internal-app` for the full Buzola, Propustka, and Vozka internal-app stack. The default is `cf-lightweight`.

Connected initialization uses `zerops-app` for a new project. A person approves the application and environment in the installed console; the local daemon receives a thirty-day app-scoped credential. The agent and application stay local. Deployment requires a clean, remotely available Git revision and runs through Control. `disconnect` removes the local key only; revoke server access in the console. See [the connected workflow](../../docs/reference/local-builder.md) for prerequisites, custody and recovery.

## Generated application state

```text
.fabrika/
  config.json
  agent-support.json
  intent/
  principles/
  architecture/
  issues/
.claude/
.agents/skills/fabrika/
.agents/skills/fabrika-app/
.codex/agents/
tests/browser/*.test.ts
```

The opice skeletons under `tests/browser/` are the executable acceptance contract. The generated issues form the implementation dependency graph.

## Environment

| Variable             | Purpose                           | Default                             |
| -------------------- | --------------------------------- | ----------------------------------- |
| `FABRIKA_PORT`       | Local daemon port                 | `19410`                             |
| `FABRIKA_SESSION_ID` | Session override                  | Stable hash of the application path |
| `FABRIKA_DATA_DIR`   | Persistent local state            | `~/.fabrika`                        |
| `FABRIKA_TIMEOUT`    | Gate wait timeout in milliseconds | `3600000`                           |
| `FABRIKA_UI_DIST`    | Dashboard build override          | Packaged `ui/dist`                  |

## Package contents

- `cli/` owns phase derivation, task packets, issue induction, and builder commands.
- `daemon/` owns HTTP/WebSocket endpoints and persistent canvas sessions.
- `ui/` owns the local dashboard.
- `skill/` contains the agent-neutral workflow and specialist roles.
- `decisions/` and `stacks/` contain the public technology catalog.

The public `@fabrika/cli` package exposes this package under `fabrika builder …`. CLI and dashboard clients communicate with the daemon only over HTTP and WebSocket.

## Development

From the `fabrika-platform` repository root:

```bash
bun run --filter @fabrika/builder typecheck
bun run --filter @fabrika/builder test
bun run --filter @fabrika/builder build
```

See [`BUILD-CONTRACT.md`](./BUILD-CONTRACT.md) for the package boundary and wire contract.
