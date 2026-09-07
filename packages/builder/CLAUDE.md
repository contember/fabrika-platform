# @fabrika/builder

The guided application builder behind `fabrika builder …`. It owns the deterministic `.fabrika/`
phase machine, its local daemon and dashboard, the installed agent skill, and the stack decision
catalog. The public `@fabrika/cli` package only routes into this package.

## Commands

```bash
bun run typecheck
bun run test
bun run build
```

The release packer runs `release:prepare` and includes `ui/dist/` in the tarball. Do not commit that
generated directory. The CLI and dashboard communicate with the daemon only over HTTP/WebSocket; do
not introduce direct imports across that process boundary.

Builder commands live under `fabrika builder`. Keep the skill and every generated command example on
that namespace. The package is public: resources and documentation must not name private repositories,
customers, services, or internal URLs.
