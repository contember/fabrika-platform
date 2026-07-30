# @fabrika/operations

The runtime-neutral Operations kernel. It owns Sentry envelope parsing and
fingerprinting, issue lifecycle decisions, event-detail parsing, source-map
resolution, alert decisions, and portable persistence capabilities.

`src/repositories.ts` is the ADR-0015 portability seam. SQLite and Postgres may
replace one complete repository operation, but shared domain code never branches
on a database identifier. `migrations/` and `migrations-postgres/` are the
parallel final schemas.

Shared entrypoints must not import Cloudflare, Bun, SQL drivers, or the
dashboard. Cloudflare adapters live in `platform-cf.ts`; Bun-only lifecycle code
lives under `src/node/`. The direct ingest surface and authenticated operator
surface remain separate exports.

Exact occurrence counts come from the append-only SQL occurrence index. Do not
replace that correctness source with sampled Analytics Engine data. Blob storage
holds raw bodies, while SQL indexes every event, source map, and dead event; the
`BlobStore` port deliberately has no listing operation.

`import/poplach-source-inventory.ts` pins and accounts for the Poplach source
import at commit `8e0c79d662c187fe41eacd0fee9fe77fde668f1f`.
