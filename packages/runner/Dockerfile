# fabrika CI runner image.
#
# Bakes in the Cloudflare provider CLI and the runner server alongside git, node, bun and wrangler,
# so a spawned container can clone a target app, install it and run `fabrika-cloudflare deploy`.
#
# BUILD CONTEXT = the fabrika-platform repo ROOT (so we can copy the workspace packages). Run via
# `bun run docker:build` (from packages/runner):
# docker build -f packages/runner/Dockerfile -t vozka-runner <repo-root>
#
# Only oblaka-iac and wrangler resolve from npm. oblaka-iac is pinned in docker/package.json to the
# version that ships the programmatic `deploy()` the engine calls.

FROM ubuntu:24.04

# Toolchain: git (clone), ca-certificates (HTTPS), curl + unzip (bun installer), bash.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		git \
		ca-certificates \
		curl \
		unzip \
		bash \
	&& rm -rf /var/lib/apt/lists/*

# Node 22+ — wrangler's CLI shebang is `#!/usr/bin/env node` and it requires Node >= 22.
# (Ubuntu 24.04's apt nodejs is v18, too old.)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
	&& apt-get install -y --no-install-recommends nodejs \
	&& rm -rf /var/lib/apt/lists/*

# bun — both the runner's own runtime and the tool that installs target apps.
RUN curl -fsSL https://bun.com/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# wrangler on PATH globally: the deploy step shells out to a bare `wrangler` (deploy-worker /
# d1 migrations / secret put) with cwd = the target repo, so it must resolve regardless of cwd.
# Pinned to match the version the Cloudflare provider builds against.
RUN bun install -g wrangler@4.72.0

WORKDIR /opt/fabrika

# A self-contained workspace containing every local package the runner and deploy CLI resolve.
# oblaka-iac comes from npm; wrangler is installed globally above.
COPY packages/runner/docker/package.json ./package.json
COPY packages/auth-core ./packages/auth-core
COPY packages/auth ./packages/auth
COPY packages/provider-contract ./packages/provider-contract
COPY packages/provider-cloudflare ./packages/provider-cloudflare
COPY packages/engine ./packages/engine
COPY packages/platform ./packages/platform
COPY packages/runner/src ./packages/runner/src
COPY packages/runner/docker/smoke ./packages/runner/docker/smoke
COPY packages/runner/package.json ./packages/runner/package.json

RUN bun install

# Expose the provider-specific CLI on PATH.
RUN printf '#!/usr/bin/env bash\nexec bun /opt/fabrika/packages/provider-cloudflare/src/cli.ts "$@"\n' > /usr/local/bin/fabrika-cloudflare \
	&& chmod +x /usr/local/bin/fabrika-cloudflare

# Where target repos are cloned. The runner server creates one sub-dir per run.
ENV VOZKA_WORKSPACE=/workspace
RUN mkdir -p /workspace

EXPOSE 8080

ENTRYPOINT ["bun", "/opt/fabrika/packages/runner/src/serve.ts"]
