# Orders: a demo of roles and approved access

A small roastery takes orders from its customers. The example shows two things on the paved road:

- **Roles.** The owner (`majitel`) holds every action. A salesperson (`obchodnik`) reaches only the customers an
  assignment row names them at: the `handling` relation, conferred by `customer_reps`. Accounting (`uctarna`) reads
  every order and keeps the invoicing records, never reads the customers, and is refused an order's delete by the
  proxy.
- **Approved access.** `../orders-demo/billing-export.patch` is an agent's change that gives accounting an export of
  the invoicing records with the customers' details. Control classifies it as widening access, so a protected
  environment waits for a person to approve it. `../orders-demo/approval-preview.ts` renders what the console shows.

It runs on Cloudflare, so `fabrika app dev` serves it on an in-memory SQLite database, with no database server. The
seed (`dev/seed.ts`) offers four personas; every name and number in it is made up. The UI speaks Czech.

```bash
bun run dev                  # builds the SPA, then fabrika app dev on http://127.0.0.1:3000/
bun tools/demo-check.ts      # against the running app dev: what each persona reaches, and the refused delete
bun test --isolate           # generated access and isolation tests, the roles, the screens
```

The demo's runbook, in Czech, is [`../orders-demo/README.md`](../orders-demo/README.md).
