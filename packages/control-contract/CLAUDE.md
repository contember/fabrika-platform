# @fabrika/control-contract

Runtime-neutral request and response DTOs for the control REST API. It also owns
`RunLogLine`, which is shared by the control API, dashboard, and runner
transport.

Keep this package safe for browser and plain-Bun consumers. It may depend on
provider-neutral envelope types, but never on `@fabrika/control`, Cloudflare
bindings, database code, or runner implementations.
