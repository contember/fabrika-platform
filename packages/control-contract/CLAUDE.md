# @fabrika/control-contract

Runtime-neutral request and response DTOs for the control API and the typed
`ControlRpcContract`. It also owns `RunLogLine`, which is shared by the control
API, dashboard, and runner transport. `src/access.ts` owns the console vocabulary — the
console app id, `CONTROL_ACTIONS` and `CONTROL_SCOPES` — which Control enforces, its IAM schema
declares, and the dashboard shows and hides by.

Keep this package safe for browser and plain-Bun consumers. It may depend on
provider-neutral envelope types and the runtime-neutral `@fabrika/app` RPC
contract types, but never on `@fabrika/control`, Cloudflare bindings, database
code, or runner implementations.
