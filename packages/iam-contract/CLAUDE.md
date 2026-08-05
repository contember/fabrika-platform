# @fabrika/iam-contract

Runtime-neutral request and response DTOs for the IAM administration API. Both `@fabrika/iam` and
browser-side `@fabrika/iam-ui` consume this package.

`IamAdminRpcContract` is the WHOLE administration API — one transport, so nothing here has to be
kept in step with a second one. What is left of `/admin/*` REST is machine provisioning (a deploy's
schema reconcile and the first-machine-caller bootstrap) and it reuses these same shapes. A new
operation is an RPC procedure; adding a REST route means showing no procedure can serve the caller.

Keep `IamRpc`, policy evaluation, token shapes, and gate domain types in
`@fabrika/auth-core`. Keep this package free of IAM runtime, database, and UI
imports.
