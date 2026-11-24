# Account-owned fabrika deploy runner image.
#
# Bakes in the Cloudflare provider CLI and the runner server alongside git, node, bun and wrangler,
# so a spawned container can clone a target app, build it in the build sandbox and deploy the result (ADR-0086).
#
# The runner runs as root. Every step that runs checkout code runs as the build user `fabrika-build` (uid 10001,
# `setpriv`, no new privileges, no capabilities, an environment of its own), and without network after the install
# when the container allows a network namespace (`unshare --net`, `ip` for the loopback). Bun, wrangler and the
# executor live outside /root, so the build user can run them and cannot change them.
#
# BUILD CONTEXT = the fabrika-platform repo ROOT (so we can copy the workspace packages). Run via
# `bun run docker:build` (from packages/runner-container):
# docker build -f packages/runner-container/Dockerfile -t fabrika-runner <repo-root>
#
# Only oblaka-iac and wrangler resolve from npm. oblaka-iac is pinned in docker/package.json to the
# version that ships the programmatic `deploy()` the Cloudflare provider calls.

FROM ubuntu:24.04

# Toolchain: git (clone), ca-certificates (HTTPS), curl + unzip (bun installer), bash, iproute2 (the loopback of the
# build's network namespace), tini (collects the build's killed processes, which the runner as PID 1 would not).
# util-linux (setpriv, unshare) is part of the base image.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		git \
		ca-certificates \
		curl \
		unzip \
		bash \
		iproute2 \
		tini \
	&& rm -rf /var/lib/apt/lists/*

# The build user. It owns nothing outside the directories the runner hands it for one run.
RUN groupadd --gid 10001 fabrika-build \
	&& useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin fabrika-build
ENV FABRIKA_BUILD_UID=10001 FABRIKA_BUILD_GID=10001
# `auto` builds with network when the container refuses a network namespace (the build holds no secret);
# `isolated` refuses every run instead.
ENV FABRIKA_RUNNER_BUILD_NETWORK=auto

# Node 22+ — wrangler's CLI shebang is `#!/usr/bin/env node` and it requires Node >= 22.
# (Ubuntu 24.04's apt nodejs is v18, too old.)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
	&& apt-get install -y --no-install-recommends nodejs \
	&& rm -rf /var/lib/apt/lists/*

# bun — both the runner's own runtime and the tool that installs target apps. The exact release of
# `.bun-version`, never the installer's default of the newest one: a newer Bun rewrites the lockfile.
# Installed under /opt/bun, not /root/.bun: the build user runs it and must not be able to change it.
COPY .bun-version /tmp/.bun-version
ENV BUN_INSTALL=/opt/bun
RUN curl -fsSL https://bun.com/install | bash -s "bun-v$(tr -d '[:space:]' < /tmp/.bun-version)"
ENV PATH="/opt/bun/bin:${PATH}"

# wrangler on PATH globally: the build bundles with it (`deploy --dry-run --outdir`) and the deploy uploads with it
# (`deploy --no-bundle`, d1 migrations, secret put), so it must resolve regardless of cwd and never from a checkout.
# Pinned to match the version the Cloudflare provider builds against.
RUN bun install -g wrangler@4.74.0

WORKDIR /opt/fabrika

# A self-contained workspace containing every local package the runner and deploy CLI resolve.
# oblaka-iac comes from npm; wrangler is installed globally above.
COPY packages/runner-container/docker/package.json ./package.json
COPY packages/app ./packages/app
COPY packages/auth-core ./packages/auth-core
COPY packages/check ./packages/check
COPY packages/email ./packages/email
COPY packages/jwks ./packages/jwks
COPY packages/db ./packages/db
COPY packages/auth ./packages/auth
COPY packages/provider-contract ./packages/provider-contract
COPY packages/proxy-core ./packages/proxy-core
COPY packages/github-app ./packages/github-app
COPY packages/iam-contract ./packages/iam-contract
COPY packages/installation-init ./packages/installation-init
COPY packages/provider-cloudflare ./packages/provider-cloudflare
COPY packages/platform ./packages/platform
COPY packages/platform-node ./packages/platform-node
COPY packages/control-contract ./packages/control-contract
COPY packages/operations-contract ./packages/operations-contract
COPY packages/runner-container/src ./packages/runner-container/src
COPY packages/runner-container/docker/smoke ./packages/runner-container/docker/smoke
COPY packages/runner-container/package.json ./packages/runner-container/package.json

RUN bun install

# Expose the provider-specific CLI on PATH.
RUN printf '#!/usr/bin/env bash\nexec /opt/bun/bin/bun /opt/fabrika/packages/provider-cloudflare/src/cli.ts "$@"\n' > /usr/local/bin/fabrika-cloudflare-executor \
	&& chmod +x /usr/local/bin/fabrika-cloudflare-executor

# Where target repos are cloned. The runner server creates one sub-dir per run, and hands the build user only the
# checkout and its build directory; the workspace itself and every file beside them stay root's.
ENV FABRIKA_RUNNER_WORKSPACE=/workspace
RUN mkdir -p /workspace && chmod 0755 /workspace

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/bun/bin/bun", "/opt/fabrika/packages/runner-container/src/serve.ts"]
