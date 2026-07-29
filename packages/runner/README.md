# @fabrika/runner

The deploy runner has two parts:

- A container server that clones an app repository and runs the baked `fabrika deploy` CLI.
- A Cloudflare Worker that starts one container per run and relays its status and logs.

Build and verify the image from the repository workspace:

```bash
cpu-lease run -n 4 -- bun run --cwd packages/runner docker:build
bun run --cwd packages/runner docker:smoke
```

The image copies every required local `@fabrika/*` workspace package. Only external runtime
dependencies such as `oblaka-iac` resolve from npm. The smoke command runs `fabrika --help` and the
same baked CLI against an offline Cloudflare fixture inside the built image. The fixture intercepts
only the two read-only state calls made by oblaka and uses synthetic credentials.
