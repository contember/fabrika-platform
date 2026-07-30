# @fabrika/operations-ui

Reusable browser UI for the Operations plane. It consumes only
`@fabrika/operations-contract` and is composed into the main dashboard.

Keep server code, persistence types, direct ingest, and runtime bindings out of
this package.

`client.ts` speaks only the dashboard's same-origin `/operations/api/*` gateway.
Routes own Operations overview, Errors, Sources and alerts, Releases, and Health;
the dashboard owns the app shell, navigation, generated Buzola route adapters,
and design tokens.
