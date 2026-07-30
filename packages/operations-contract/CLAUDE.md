# @fabrika/operations-contract

Browser- and runtime-safe request, response, and domain DTOs for the Operations
plane. Direct ingest and managed environment shapes live in `src/ingest.ts`.
Issue mutation domain types live in `src/operator.ts`; authenticated operator
HTTP DTOs live in `src/operator-api.ts`. Catalog, release, and access protocols
live in their named modules.

Keep this package free of runtime, persistence, authorization, and UI imports.
Do not expose database row shapes or Cloudflare binding types.
