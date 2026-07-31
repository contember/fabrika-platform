# @fabrika/operations-contract

Browser- and runtime-safe request, response, and domain DTOs for the Operations
plane. Direct ingest and managed environment shapes live in `src/ingest.ts`.
Issue mutation domain types live in `src/operator.ts`; authenticated operator
HTTP DTOs live in `src/operator-api.ts`. Catalog, release, and access protocols
live in their named modules. `src/rpc.ts` owns the browser-safe named operator
procedures implemented by Operations and consumed by `@fabrika/operations-ui`.

The runtime-neutral `@fabrika/app` RPC contract type is allowed. Keep this
package free of runtime implementations, persistence, authorization, and UI
imports. Do not expose database row shapes or Cloudflare binding types.
