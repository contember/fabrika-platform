# @fabrika/operations-ui

Reusable browser UI for the Operations plane. It consumes
`@fabrika/operations-contract` through the runtime-neutral `@fabrika/app` RPC
client and is composed into the main dashboard.

Keep server code, persistence types, direct ingest, and runtime bindings out of
this package.

`client.ts` uses `OperationsRpcContract` through the dashboard's same-origin
`/operations/api/rpc` gateway.
Routes own Operations overview, Errors, Sources and alerts, Releases, and Health;
the dashboard owns the app shell, navigation, generated Buzola route adapters,
and design tokens.
