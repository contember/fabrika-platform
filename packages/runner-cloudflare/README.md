# @fabrika/runner-cloudflare

The Cloudflare Worker that starts one deploy container per run, relays logs and status to R2, and
records terminal outcomes in the control-plane database.

It is deployed out of band because deploying the control plane must not reset its active deploy
container. The plain-Bun container image lives in `@fabrika/runner-container`. Each account's
platform workflow builds it from the exact `fabrika.ref` checkout into that account's registry;
upstream CI does not publish or pin a shared runner image.
Runner rollouts give active containers 20 minutes before they become eligible for replacement, so
normal deploys can finish or persist terminal state.
