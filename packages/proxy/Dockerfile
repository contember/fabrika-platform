# syntax=docker/dockerfile:1
#
# The proxy's container image, as a namespace proxy on AWS is built (`packages/provider-aws/src/proxy-build.ts`).
#
# BUILD CONTEXT = the repository root of the pinned commit, with the proxy manifest beside it at `proxy.manifest.json`:
# the archive Control uploads is that commit plus that one data file (ADR-0045). The build reads the manifest, never the
# environment, so a running proxy never serves a manifest newer than its image:
#
# docker build --platform linux/amd64 --file packages/proxy/Dockerfile --tag <tag> <context>
#
# This recipe lives in the commit, not in a provider: a namespace keeps its pinned proxy source through a Control
# upgrade, and only the commit knows how its own proxy is built. It does what the proxy setup of `zerops.yaml` does:
#
# - Caddy from its module at v2.10.2, which the Go checksum database verifies, as a static binary (CGO off);
# - `generate-config.ts` turns the manifest into `caddy.json` (a missing or malformed manifest fails the build, so the
# previous image keeps serving; an empty app list generates only the terminal 404 route);
# - the auth service compiled to one musl binary (`bun-linux-x64-musl`, the only target the package builds, so the
# image is linux/amd64 only);
# - a plain Alpine runtime with Caddy, the binary, `caddy.json`, the manifest and `start.sh`.
#
# Listeners: the public one on :8080 and the health route alone on :8081 (`caddy.ts`'s defaults). There is no TLS
# anywhere: the balancer in front terminates it. `FABRIKA_PROXY_TRUSTED_PROXIES` is a build argument, because
# `generate-config.ts` bakes the ranges into `caddy.json`. Empty, Caddy trusts no forwarding header.
#
# The runtime's secrets (`FABRIKA_IAM_KEY`, the per-application proxy secrets) are the task's environment, never the
# image's.
#
# Every base image is pinned by digest (the tag beside it is a label only): a rebuild of the same commit and manifest
# builds the same layers.

FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS caddy
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.10.2

# The exact release of `.bun-version`: a newer Bun rewrites the lockfile, which `--frozen-lockfile` refuses.
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --filter './packages/*'
ARG FABRIKA_PROXY_TRUSTED_PROXIES=""
RUN bun run packages/proxy/src/generate-config.ts ./proxy.manifest.json ./caddy.json --auth-upstream 127.0.0.1:9000
RUN bun build --compile --target=bun-linux-x64-musl ./packages/proxy/src/main.ts --outfile ./fabrika-proxy

FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
# The C++ runtime a Bun musl binary links, from the pinned Bun image rather than an unpinned package index.
COPY --from=build /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /usr/lib/
WORKDIR /app
COPY --from=caddy /out/caddy ./caddy
COPY --from=build /src/fabrika-proxy /src/caddy.json /src/proxy.manifest.json ./
COPY --from=build /src/packages/proxy/start.sh ./packages/proxy/start.sh
# An image whose binary cannot load its libraries, or whose configuration Caddy refuses, is never pushed.
RUN ldd ./fabrika-proxy > /dev/null && ./caddy validate --config ./caddy.json
ENV FABRIKA_PROXY_MANIFEST=/app/proxy.manifest.json \
    FABRIKA_PROXY_PORT=9000 \
    XDG_CONFIG_HOME=/tmp \
    XDG_DATA_HOME=/tmp
# Neither process needs root: both listen above 1024, and Caddy's own state goes to /tmp.
USER 65534:65534
EXPOSE 8080 8081
CMD ["sh", "/app/packages/proxy/start.sh"]
