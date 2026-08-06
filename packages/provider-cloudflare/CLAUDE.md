# @fabrika/provider-cloudflare

The Cloudflare provider bundle: app authoring (`defineApp`), the deploy plan and its executor, the
control-side provider, and the proxy topology. Assumes the root CLAUDE.md. Implements the open
contracts in `@fabrika/provider-contract`; the deploy executor that runs the plan is
`@fabrika/engine`.

It re-exports `oblaka-iac` wholesale, so an app's `fabrika.config.ts` gets its resource types from
this one import.

## Invariants

- **This package OWNS `CloudflareRunnerJob` and its validator.** `@fabrika/runner-contract` holds
  only transport types and endpoint constants; `@fabrika/runner-container` owns the Bun process and
  image; `@fabrika/runner-cloudflare` owns the executor Worker. Provider job semantics stay here.
- **Installation credentials never enter a persisted envelope.** `CloudflareStoredTarget` holds
  coordinates only; `CloudflareTarget` carries the ephemeral credentials for ONE run and is composed
  at run time.
- **Codecs validate on the way in.** A module default imported from a runner checkout is untrusted —
  narrow it with `isCloudflareAppConfig`, never assume the shape.
- **This package is one of the four that relax two strict flags for oblaka** — see the root
  CLAUDE.md. Keep our own code strict; never work around oblaka with a cast.
- **The plan is ordered step kinds**, not free-form work: `build` → `provision-resources` →
  `migrate` → `deploy-worker` → `reconcile-schema` → `sync-secrets`. The engine executes steps by id
  in the order supplied and never interprets a `ProviderJobSpec.kind`.
- **The proxy topology is: public Worker owns the route, private application Worker is bound to it.**
  IAM remains a global service binding. See ADR-0022.
- **Proxy invocation logs stay disabled.** The reserved handoff callback carries a one-time code in
  its query string, and Cloudflare's automatic invocation metadata is outside the proxy's redaction
  layer. Structured application logs remain enabled and redact request queries.
- **Never log credentials or secret values** — including an error object from a failed `wrangler`
  invocation, whose output can quote a clone URL with an embedded token.
