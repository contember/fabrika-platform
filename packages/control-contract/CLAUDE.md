# @fabrika/control-contract

Runtime-neutral request and response DTOs for the control API and the typed
`ControlRpcContract`. It also owns `RunLogLine`, which is shared by the control
API, dashboard, and runner transport. `src/access.ts` owns the console vocabulary — the
console app id, `CONTROL_ACTIONS` and `CONTROL_SCOPES` — which Control enforces, its IAM schema
declares, and the dashboard shows and hides by.

`src/cli-access.ts` owns what the `fabrika` CLI's device grant may hold: the presets, their grants and the console's
two OAuth resources (`CONTROL_CLI_RESOURCES`), which every provider registers and IAM's config is computed from.

Keep this package safe for browser and plain-Bun consumers. It may depend on
provider-neutral envelope types, the runtime-neutral `@fabrika/app` RPC
contract types and `@fabrika/operations-contract`'s actions (one way: that package never imports this one), but never on `@fabrika/control`, Cloudflare bindings, database
code, or runner implementations.
