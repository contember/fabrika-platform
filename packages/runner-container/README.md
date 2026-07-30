# @fabrika/runner-container

The plain-Bun container server that clones an app repository and runs the baked
`fabrika-cloudflare-executor deploy` CLI. The Cloudflare host lives in `@fabrika/runner-cloudflare`.

Build and verify the image from the repository workspace:

```bash
cpu-lease run -n 4 -- bun run --cwd packages/runner-container docker:build
bun run --cwd packages/runner-container docker:smoke
```

The image copies every required local `@fabrika/*` workspace package. Only external runtime
dependencies such as `oblaka-iac` resolve from npm.
