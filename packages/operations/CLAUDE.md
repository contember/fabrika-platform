# @fabrika/operations

The runtime-neutral Operations kernel. It owns Sentry envelope parsing and
fingerprinting, issue lifecycle decisions, event-detail parsing, source-map
resolution, and alert decisions.

Keep persistence and runtime bindings behind later composition roots. Shared
entrypoints must not import Cloudflare, Bun, SQL drivers, or the dashboard. The
direct ingest surface and authenticated operator surface remain separate
exports.

`import/poplach-source-inventory.ts` pins and accounts for the Poplach source
import at commit `8e0c79d662c187fe41eacd0fee9fe77fde668f1f`.
