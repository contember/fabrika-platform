// The repository-root `zerops.yaml`, as typed values.
//
// ── The decision this file IS ──────────────────────────────────────────────────────────────────────
//
// Zerops reads `zerops.yaml` from the REPOSITORY ROOT, and fabrika is a monorepo with three deployable
// services in it. There were two ways to make that coherent:
//
//   A. ONE root `zerops.yaml` with several named setups; each service's build selects its own by name
//      (`zeropsSetup`, which defaults to the service hostname).
//   B. Per-service `zeropsYaml` inlined into the import document fabrika generates.
//
// **A, and the per-package `packages/*/zerops.yaml` files are superseded by this one.** Four reasons,
// in the order they matter:
//
//   1. **The build spec must be the same however the build was triggered.** An inline `zeropsYaml` is
//      present only on builds fabrika itself triggers. A `zcli service push`, a git-push trigger, a tag,
//      or the GUI's "rebuild" button would all build with whatever the repo says instead — i.e. with
//      something else. That divergence surfaces exactly when someone is debugging a failed deploy, which
//      is the worst possible moment to discover the build they are looking at is not the build that ran.
//   2. **`override: true` turns an inline `zeropsYaml` into a silent rewrite.** fabrika re-applies the
//      import on every deploy; option B would have it overwrite the service's build configuration each
//      time, including one a human deliberately changed in the GUI. That is the same failure ADR-0004
//      rejected for secrets, one level up.
//   3. Setup name == service hostname is the platform's own default matching rule, so option A needs no
//      extra wiring for the common case, and `zeropsSetup` stays available for the uncommon one.
//   4. It keeps `zeropsYaml` free for what it is genuinely good at: a targeted per-deploy OVERRIDE. The
//      provider compiler still supports it (`ZeropsServiceSpec.zeropsYaml`); it is simply not how a
//      service's normal build is described.
//
// ── The rule for `envVariables` in here ────────────────────────────────────────────────────────────
//
// This file is COMMITTED and PLAINTEXT, and it is the same file for every installation. So it carries
// only values that are true for EVERY installation: ports, asset directories, intra-project hostnames,
// and `${service_variable}` references the platform resolves at runtime. A reference is not a value —
// `${db_connectionString}` is a pointer into the platform's own variable store, which is precisely where
// ADR-0004 says the value belongs.
//
// Two categories are therefore deliberately ABSENT, and each setup lists its own below:
//
//   • per-installation configuration (public origins, cookie domains, OIDC coordinates, admission
//     lists) — set as service-level variables through the env API;
//   • every secret — set as service-level `envSecrets`, addressed by service, never through a document.
//
// (The superseded `packages/iam/zerops.yaml` baked `ISSUER: https://iam.example.com` and
// `SESSION_COOKIE_DOMAIN: .example.com`. Those are per-installation, and a placeholder domain in a
// committed file is a value that boots wrong rather than not booting.)

import type { ZeropsYaml, ZeropsYamlSetup } from '@fabrika/provider-zerops'
import { FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'

/**
 * Deploy the whole workspace as complete top-level trees, not the individual packages.
 *
 * The workspace links `node_modules/@fabrika/*` at `packages/*`, so copying `node_modules` and
 * `packages` whole keeps those links resolvable whether the platform preserves symlinks or dereferences
 * them. Listing leaf packages individually breaks on the dereferencing case.
 */
const WORKSPACE_DEPLOY_FILES = ['package.json', 'bun.lock', 'node_modules', 'packages']

/**
 * The IAM service — identity, tokens, audit, and the private admin API.
 *
 * Per-installation variables (env API): `ISSUER` (this service's public origin; it is the `iss` of every
 * minted token AND the OIDC redirect base, so it must match the domain routed to the proxy in front of
 * it), `SESSION_COOKIE_DOMAIN`, `HUMAN_EMAIL_DOMAINS`, `HUMAN_EMAILS`, `IAM_BOOTSTRAP_ADMINS`,
 * `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_SCOPES`, `OIDC_REQUIRE_VERIFIED_EMAIL`.
 *
 * Secrets (`envSecrets`): `FABRIKA_IAM_SIGNING_KEYS` (ES256 private JWKs — an empty value is refused at
 * boot rather than silently issuing ephemeral tokens), `OIDC_CLIENT_SECRET`, `FABRIKA_IAM_RPC_KEY` (gates
 * the management `/rpc/*` surface; unset 404s it, which is the fail-closed default), `FABRIKA_IAM_PROXY_KEY`
 * (gates `/auth/mint/*`, which the proxy calls on the cold path — a SEPARATE secret by least privilege,
 * since the proxy is the only publicly routed component and must not also be able to write audit rows),
 * `FABRIKA_IAM_PROVISIONING_KEY`. Both shared secrets must be at least 32 characters; a shorter one fails
 * the boot rather than standing in front of an internet-reachable surface while looking configured.
 */
const iam: ZeropsYamlSetup = {
	setup: 'iam',
	build: {
		// Bun on Alpine. `build.os` is deprecated in the published schema — the OS is part of the base id.
		base: ['alpine/bun@1.3'],
		buildCommands: ['bun install --frozen-lockfile'],
		deployFiles: WORKSPACE_DEPLOY_FILES,
		cache: ['node_modules'],
	},
	run: {
		base: 'alpine/bun@1.3',
		// Migrations at container start — the Zerops analogue of a discrete migrate step in a Cloudflare
		// plan, and the reason the Zerops deploy plan has no `migrate`. Safe to repeat: the runner records
		// what it applied and serializes concurrent containers behind a session-level advisory lock.
		// Runs in /var/www.
		initCommands: ['bun packages/iam/src/node/migrate.ts'],
		start: 'bun packages/iam/src/node/server.ts',
		// `protocol` is omitted deliberately. TCP is the default at both ends, and the two published
		// sources disagree about its spelling: the JSON schema's enum is lowercase (`tcp`/`udp`) while its
		// own description — and every doc example — says `TCP`. Not writing it sidesteps a contradiction we
		// cannot resolve without an account.
		ports: [{
			port: 3000,
			// The project's L7 balancer terminates TLS and forwards plain HTTP over the private network, so
			// this process holds no certificates.
			httpSupport: true,
		}],
		// Liveness, not readiness: it answers "is this process serving?" and never touches Postgres. A
		// health check that queried the database would let one slow query restart every container at once.
		healthCheck: { httpGet: { port: 3000, path: '/healthz' } },
		// The Cloudflare `scheduled` handler's replacement, running the same code path. `allContainers:
		// false` so a horizontally scaled service still prunes once.
		crontab: [{ timing: '0 3 * * *', command: 'bun packages/iam/src/node/prune.ts', allContainers: false }],
		envVariables: {
			PORT: '3000',
			// The DIRECT Postgres port (5432), not pgBouncer on 6432. Load-bearing: the migration runner
			// takes a session-level advisory lock, and pgBouncer's transaction pooling does not preserve
			// session state across statements. `${db_...}` is a reference to the `db` service's own variable
			// — the value lives in the platform and never appears here.
			FABRIKA_IAM_DATABASE_URL: '${db_connectionString}',
			ENVIRONMENT: 'prod',
		},
	},
}

/**
 * The control plane — registry, run lifecycle, vault, webhook, and the dashboard SPA.
 *
 * Per-installation variables (env API): `FABRIKA_CONTROL_DOMAIN`, `FABRIKA_IAM_URL` (the public IAM issuer),
 * `OPERATIONS_ARTIFACT_ORIGIN` (the public proxy origin for source-map upload), `CLOUDFLARE_ACCOUNT_ID`,
 * `FABRIKA_CONTROL_BOOTSTRAP_ADMINS`, `ZEROPS_CLIENT_ID`, `ZEROPS_PROXY_BUILD_FROM_GIT`, and
 * `ZEROPS_PROXY_IAM_URL` (the public IAM origin reachable from application projects).
 *
 * Secrets (`envSecrets`): `FABRIKA_IAM_RPC_KEY` (authenticates this process to IAM's RPC surface — the
 * same value IAM holds), `FABRIKA_CONTROL_VAULT_KEY` (the vault KEK; its loss is unrecoverable by design),
 * `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `CLOUDFLARE_API_TOKEN`,
 * `FABRIKA_IAM_PROVISIONING_KEY`, `ZEROPS_PROXY_IAM_KEY` (the same credential IAM receives as
 * `FABRIKA_IAM_PROXY_KEY`), `OPERATIONS_SYNC_KEY` (the same catalog credential Operations receives),
 * and — when this control plane deploys to Zerops — `ZEROPS_ACCESS_TOKEN`, the Zerops personal access
 * token. It carries account-wide admin rights and is the single most dangerous thing an installation
 * holds.
 *
 * There is NO runner service anywhere in this topology, and that is ADR-0003, not an omission: Zerops
 * has its own CI, so a deploy here is five HTTP calls made by this process.
 */
const control: ZeropsYamlSetup = {
	setup: 'control',
	build: {
		base: ['alpine/bun@1.3'],
		buildCommands: ['bun install --frozen-lockfile', 'bun run --filter @fabrika/dashboard build'],
		deployFiles: WORKSPACE_DEPLOY_FILES,
		cache: ['node_modules'],
	},
	run: {
		base: 'alpine/bun@1.3',
		initCommands: ['bun packages/control/src/node/migrate.ts'],
		start: 'bun packages/control/src/node/server.ts',
		ports: [{ port: 3000, httpSupport: true }],
		healthCheck: { httpGet: { port: 3000, path: '/healthz' } },
		crontab: [{ timing: '*/5 * * * *', command: 'bun packages/control/src/node/cron.ts', allContainers: false }],
		envVariables: {
			PORT: '3000',
			FABRIKA_CONTROL_DATABASE_URL: '${db_connectionString}',
			FABRIKA_CONTROL_ASSETS_DIR: 'packages/dashboard/dist',
			ENVIRONMENT: 'prod',
			// Intra-project transport for management RPC. `FABRIKA_IAM_URL` is deliberately absent here:
			// it is the public token issuer and is supplied per installation through the env API.
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_OPERATIONS_URL: 'http://operations:3000',
			// Run logs, in the project's own S3-compatible object storage. All four are REFERENCES to the
			// `storage` service's generated variables; the credentials themselves live in the platform and
			// are resolved at container start. Nothing secret is committed by writing a pointer to it.
			FABRIKA_CONTROL_RUN_LOGS_BUCKET: '${storage_bucketName}',
			FABRIKA_CONTROL_RUN_LOGS_ENDPOINT: '${storage_apiUrl}',
			FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: '${storage_accessKeyId}',
			FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: '${storage_secretAccessKey}',
			// MinIO's conventional region. `S3BlobStore` uses path-style addressing, which MinIO wants and
			// R2/AWS accept, so the same implementation serves both platforms unchanged.
			FABRIKA_CONTROL_RUN_LOGS_REGION: 'us-east-1',
		},
	},
}

/**
 * Operations is private inside the platform project. The proxy is its only public ingress and its
 * manifest must route only `/api/{projectId}/envelope/` for the configured public hostname.
 *
 * Per-installation variables (env API): `FABRIKA_OPERATIONS_PUBLIC_HOST` and `FABRIKA_IAM_URL`
 * (the public IAM issuer).
 *
 * Secrets (`envSecrets`): `OPERATIONS_SYNC_KEY`, shared only with control for catalog projection, and
 * `FABRIKA_IAM_RPC_KEY`, used only for Operations → IAM management RPC.
 */
const operations: ZeropsYamlSetup = {
	setup: 'operations',
	build: {
		base: ['alpine/bun@1.3'],
		buildCommands: ['bun install --frozen-lockfile'],
		deployFiles: WORKSPACE_DEPLOY_FILES,
		cache: ['node_modules'],
	},
	run: {
		base: 'alpine/bun@1.3',
		initCommands: ['bun packages/operations/src/node/migrate.ts'],
		start: 'bun packages/operations/src/node/server.ts',
		ports: [{ port: 3000, httpSupport: true }],
		healthCheck: { httpGet: { port: 3000, path: '/healthz' } },
		crontab: [{ timing: '* * * * *', command: 'bun packages/operations/src/node/cron.ts', allContainers: false }],
		envVariables: {
			PORT: '3000',
			ENVIRONMENT: 'prod',
			FABRIKA_OPERATIONS_DATABASE_URL: '${operationsdb_connectionString}',
			FABRIKA_OPERATIONS_BLOB_BUCKET: '${operationsstorage_bucketName}',
			FABRIKA_OPERATIONS_BLOB_ENDPOINT: '${operationsstorage_apiUrl}',
			FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID: '${operationsstorage_accessKeyId}',
			FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY: '${operationsstorage_secretAccessKey}',
			FABRIKA_OPERATIONS_BLOB_REGION: 'us-east-1',
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_CONTROL_URL: 'http://control:3000',
		},
	},
}

/**
 * The auth enforcement proxy — Caddy for HTTP correctness, a compiled Bun auth service for every
 * authorization decision (ADR-0008, as amended by ADR-0010: gates are NEVER compiled into Caddy routes).
 *
 * This is the only setup deployed into BOTH projects, and the only publicly routed service in either.
 *
 * Per-service variables (env API): `FABRIKA_IAM_URL` — `http://iam:3000` in the platform project, the
 * IAM service's PUBLIC origin in an apps project, because there is no private network between projects
 * (ADR-0006). And `FABRIKA_PROXY_MANIFEST_JSON`; see below.
 *
 * Secret (`envSecrets`): `FABRIKA_IAM_KEY` — the value IAM knows as `FABRIKA_IAM_PROXY_KEY`.
 *
 * ── How the manifest reaches the build, and what is unverified about it ───────────────────────────
 *
 * `proxy.manifest.json` tells the proxy which apps it fronts, at which upstream, under which gates. It
 * is baked into the artifact at BUILD time, which is what `docs/backlog/08` chose ("redeploy") over
 * pushing to Caddy's admin API. But on Zerops fabrika has no filesystem in the deploy path — a Zerops
 * deploy is five HTTP calls (ADR-0003) — so the driver cannot write a file into the build the way the
 * Cloudflare path can. The only write channel it has is the service-level env API, the same one it uses
 * for secrets, so the manifest travels as a service variable and the build materializes it to a file.
 *
 * The control plane writes `FABRIKA_PROXY_MANIFEST_JSON` through the service-level env API and rolls
 * this service before each app deploy (`packages/control/src/node/zerops-proxy.ts`). One live-account fact
 * remains to verify: Zerops documents build variables but does not clearly state whether a build sees
 * its service's runtime variables. If it does not, materialization moves into `run.initCommands`; the
 * delivery channel and fail-closed parser stay unchanged.
 *
 * What IS structural: missing or malformed JSON makes `generate-config.ts` exit non-zero, so the
 * pipeline fails and the previous version keeps serving. A valid empty app list generates only the
 * terminal 404 route, and the auth service denies every forwarded request.
 */
const proxyManifestReference = `\${${FABRIKA_PROXY_MANIFEST_JSON}}`

const proxy: ZeropsYamlSetup = {
	setup: 'proxy',
	build: {
		// Two toolchains: Go builds Caddy, Bun compiles the auth service to a single musl binary so the
		// runtime container needs no interpreter at all.
		//
		// `alpine/go@latest` rather than a pin, and that is a real trade stated out loud: Caddy v2.10.2
		// requires a Go toolchain newer than the newest PINNED Go in the published schema's build enum
		// (`alpine/go@1.22`). So the Caddy version is pinned by module — verified against the Go checksum
		// database, a stronger supply-chain guarantee than a release tarball with a hand-copied hash — and
		// the toolchain floats. If a future Go release breaks the build, this is the line that moved.
		base: ['alpine/go@latest', 'alpine/bun@1.3'],
		// CGO off makes the binary static, which is what lets it run on Alpine/musl.
		prepareCommands: ['CGO_ENABLED=0 GOBIN=/tmp/gobin go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.10.2'],
		buildCommands: [
			'bun install --frozen-lockfile',
			// See the header: the manifest arrives as a service variable because the driver has no
			// filesystem. `printf` rather than `echo` so a leading `-` or a backslash survives intact.
			`printf %s "${proxyManifestReference}" > ./proxy.manifest.json`,
			// Missing/malformed JSON fails the build; an empty app list emits only deny/404 routes.
			'bun run packages/proxy/src/generate-config.ts ./proxy.manifest.json ./caddy.json --auth-upstream 127.0.0.1:9000',
			'bun build --compile --target=bun-linux-x64-musl ./packages/proxy/src/main.ts --outfile ./fabrika-proxy',
			'cp /tmp/gobin/caddy ./caddy',
		],
		deployFiles: ['caddy', 'fabrika-proxy', 'caddy.json', 'proxy.manifest.json', 'packages/proxy/start.sh'],
		cache: ['node_modules', '/root/go/pkg/mod'],
	},
	run: {
		// Alpine custom runtime: an arbitrary static binary with an arbitrary start command. No TLS config
		// anywhere on purpose — the project's L7 balancer terminates TLS, so Caddy serves plain HTTP behind
		// it and needs no ACME, no certificate storage and therefore no disk.
		base: 'alpine@3.21',
		ports: [{ port: 8080, httpSupport: true }],
		// Deliberately NOT on 8080: a health path on the public listener would be one path per proxy that
		// answers 200 without consulting the gates, and would shadow an app path of the same name.
		healthCheck: { httpGet: { port: 8081, path: '/healthz' } },
		envVariables: {
			FABRIKA_PROXY_MANIFEST: '/var/www/proxy.manifest.json',
			// Loopback only; Caddy dials it. It must never be routable.
			FABRIKA_PROXY_PORT: '9000',
		},
		start: 'sh /var/www/packages/proxy/start.sh',
	},
}

/** The repository-root `zerops.yaml`, in the order the setups appear in it. */
export const fabrikaZeropsYaml: ZeropsYaml = { zerops: [iam, operations, control, proxy] }
