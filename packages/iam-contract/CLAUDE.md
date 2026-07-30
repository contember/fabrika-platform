# @fabrika/iam-contract

Runtime-neutral request and response DTOs for the IAM admin REST API. Both
`@fabrika/iam` and browser-side `@fabrika/iam-ui` consume this package.

Keep `IamRpc`, policy evaluation, token shapes, and gate domain types in
`@fabrika/auth-core`. Keep this package free of IAM runtime, database, and UI
imports.
