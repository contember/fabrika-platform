# Builder contract

## Package boundary

`@fabrika/builder` owns one complete guided-build feature:

- deterministic phase and issue logic under `cli/`
- the local daemon under `daemon/`
- the packaged dashboard under `ui/dist/`
- installed agent support under `skill/`
- the public stack and technology catalog under `stacks/` and `decisions/`

`@fabrika/cli` is the only public `fabrika` executable. It routes arguments after `fabrika builder` to `runBuilderCli()`.

The builder CLI and dashboard must not import daemon implementation modules. They communicate through HTTP and WebSocket endpoints. The daemon is the only builder layer that imports `@fabrika/canvas-kernel/server`.

## Phase model

The ordered phases are intake, vision, flows, technology, design, skeletons, issues, and build. A phase is complete when every required output exists and its review gate, when present, has submitted and consumed feedback.

The phase is always derived from application files and gate state. No mutable phase counter is authoritative.

## Application state

`fabrika builder init` creates `.fabrika/config.json`, layered artifact directories, and `tests/browser/`. It installs agent support without overwriting user-edited generated files.

The stable session ID identifies dashboard revisions. Persistent daemon state defaults to `~/.fabrika` and can be moved with `FABRIKA_DATA_DIR`.

Project registration is independent of canvas revisions. Optional connection and preview fields are non-secret. Credentials are stored separately outside registered projects, and approved installation origins are pinned independently of project JSON.

## Platform operations

Shared parsed DTOs live in `shared/`. CLI and UI use `/api/project/:id/register`, `/platform`, `/connect`, `/disconnect`, `/deploy` and `/preview`. The daemon owns pairing, credential custody, isolated local compilation, Control RPC calls and run observation. No key enters browser state or compiler environment.

The installed console owns human application creation/selection and initial placement approval. The daemon updates environments and triggers exact remotely available commits; it does not create repositories, commit, push or deploy directly to the provider. Disconnect is local deletion, not remote revocation.

## Gate protocol

1. `gate open` sends one view or a directory of views to `POST /api/session/:id/plan`.
2. The daemon compiles the selected canvas files and creates a revision.
3. The dashboard submits feedback over `/ws/session/:id`.
4. `gate wait` observes feedback without consuming it.
5. `advance` validates outputs and consumes the latest feedback.

Only `advance` consumes feedback. This keeps retries and re-opened gates pending until the agent explicitly advances.

## Release artifact

The release packer runs `release:prepare`, which builds the dashboard into `ui/dist/`. The npm package includes runtime source, dashboard assets, skills, decisions, and stack presets. Tests and development-only source are excluded.
