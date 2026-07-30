# @fabrika/runner-cloudflare

The Cloudflare Worker that starts one deploy container per run, relays logs and status to R2, and
records terminal outcomes in the control-plane database.

It is deployed out of band because deploying the control plane must not reset its active deploy
container. The plain-Bun container image lives in `@fabrika/runner-container`.
