# Environment

The checks and the reviewers run against the local stack (`docs/reference/local-development.md`), at 1440 × 900.

```sh
bun run local:up        # the Docker stack; the console at http://control.fabrika.localhost:18080
bun run local:smoke     # Notes deployed to prod
bun run local:seed      # a second environment, secrets, a changed policy on prod, a deploy waiting for approval
```

- **Sign-in.** The stack's development login signs a browser in as the local administrator when it opens the
  console; nothing is typed. Every task runs as that administrator.
- **Ports.** The host ports are fixed, so one stack runs on the machine at a time and the two reviewers run one after
  the other.
- **Writes.** `t02-deploy`, `t05-rotate-secret` and `t08-grant-self` write data. Each can run again on the same stack;
  for a measurement comparable with the baseline, start from `local:reset`, then the three commands above.
- **Data states.** The local stack is the Zerops composition, which has no ops channel, so an environment's Data page
  shows no maintenance or recovery state. A round that judges those states says so and uses demo answers in the
  browser, labelled as such.
- **The console under review** is `packages/dashboard/dist` of the checkout that runs the stack: rebuild it with
  `bun run build` in `packages/dashboard` after a change.
