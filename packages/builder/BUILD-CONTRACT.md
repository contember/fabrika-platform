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

The ordered phases are intake, vision, flows, technology, skeletons, issues, and build. A phase is complete when every required output exists and its review gate, when present, has submitted and consumed feedback.

Design is reviewed inside the build, on the running application: `induce` writes the design checkpoint `ISSUE-004` (`gate: design-checkpoint`, a name the removed design phase never used, so none of its old reviews counts), which depends on the foundation issues and which every feature issue depends on. `build done` on an issue with a `gate` records that gate's latest reviewed revision and its verdict as the issue's evidence, through `POST /api/session/:id/gate/:name/consume`; it refuses while the gate has no submitted feedback.

The design checkpoint also carries a deterministic check, beside its advisory verdict. `.fabrika/architecture/design.md` names the theme stylesheet in its front matter (`stylesheet:`, repository-relative). `fabrika builder design review` and `build done` read that stylesheet's top-level `:root` and `:root[data-theme='dark']` custom properties over the `theme.css` of the `@fabrika/ui` that resolves from the stylesheet's directory, cascade them as the browser does (the kit's dark rule outranks an application's `:root`), and compute the WCAG 2 contrast of the pairs the kit's components draw: 4.5:1 for text, 3:1 for the focus ring. `build done` refuses a pair below that unless `--waive-contrast` is passed, and refuses while `design.md` names no stylesheet inside the repository; the evidence records the summary and any waiver. A pair the kit's own values already leave below AA, which the override does not lower, is shown and does not refuse. A colour the check cannot read (`color-mix()`, a named colour, a translucent background) is reported unchecked, never passed. A stylesheet from which `@fabrika/ui` does not resolve is a stack without the kit and is not checked.

The phase is always derived from application files, gate state and `.fabrika/approvals.json`. No mutable phase counter is authoritative. On success `advance` records, for a gated phase, the sha256 of every file the phase reads or produces and the gate revision whose review it approved (`approvals.json`, `version: 1`; `--force` marks the approval `waived` instead). The files are hashed when `advance` runs, so an edit made between the review and `advance` is approved with it. Once the file exists, a gated phase is complete only with an approval whose files are unchanged, plus, unless the approval is waived, a reviewed gate whose latest revision is the approved one. A stale phase is approved again only on a newer revision of its own gate. A file that does not parse, or of another version, is refused with a repair hint. The earliest gated phase whose files changed is current again, and its packet lists them on a `Stale:` line. The skeletons' approval covers only what they read, because the build fills in the test bodies. `init` writes an empty file for a new project. A project without the file is judged by its gate reviews alone until its first `advance`, which also records the gated phases it has already completed.

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

`advance` consumes the current phase's own gate (`POST /api/session/:id/gate/:name/consume`), and re-opening a gate over pending feedback consumes that feedback and answers 409 with it. `gate wait` never consumes, so a retried wait sees the same feedback. A gate counts as reviewed once its latest revision's feedback was consumed, but in a project that keeps approvals only `advance` completes its phase; its verdict (the `verdict` answer) is recorded, and `advance` warns, without refusing, on anything but `Approve`.

## Release artifact

The release packer runs `release:prepare`, which builds the dashboard into `ui/dist/`. The npm package includes runtime source, dashboard assets, skills, decisions, and stack presets. Tests and development-only source are excluded.
