# The platform's services' container image on AWS: IAM, Control (with the console it serves) and Operations, one image
# that each service's task definition starts with its own command (`packages/provider-aws/src/installation/`).
#
# BUILD CONTEXT = the repository root of the installation's release commit. The installation's image build checks the
# commit out by its full id and builds it on x86, as the platform proxy's is (`packages/proxy/Dockerfile`):
#
# docker build --platform linux/amd64 --file packages/provider-aws/platform.Dockerfile --tag <tag> <context>
#
# It does what the Zerops setups of IAM, Control and Operations do (`provider-zerops/src/installation/topology/setups.ts`):
# the workspace packages installed from the lockfile, without the root package's tooling, and the console built. The
# migrations run as each service starts, from its task definition's command, never at build time: the build holds no
# database URL.
#
# This recipe lives in the commit, not in a provider: an installation builds the release it runs with that release's
# own recipe.
#
# The base image is pinned by digest (the tag beside it is a label only), the exact release of `.bun-version`.

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --filter './packages/*'
RUN bun run --filter @fabrika/dashboard build

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
WORKDIR /app
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
# No service needs root: each listens above 1024.
USER bun
