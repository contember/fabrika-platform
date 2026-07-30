# @fabrika/operations-contract

Browser- and runtime-safe request, response, and domain DTOs for the Operations
plane. Direct ingest shapes live in `src/ingest.ts`; authenticated operator
shapes live in `src/operator.ts`.

Keep this package free of runtime, persistence, authorization, and UI imports.
Do not expose database row shapes or Cloudflare binding types.
