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
//   2. **An inline `zeropsYaml` would be frozen at the service's creation.** Verified live: re-applying
//      an import at a service that already exists changes NOTHING — `override: true` only stops the
//      hostname collision from failing the import, it does not update any field. So under option B a
//      service's build specification would be whatever the FIRST import wrote, and every later edit to
//      it would be accepted by the API and silently ignored. A build spec that cannot be changed after
//      day one is worse than one that lives in the repository.
//   3. Setup name == service hostname is the platform's own default matching rule, so option A needs no
//      extra wiring for the common case, and `zeropsSetup` stays available for the uncommon one.
//   4. It keeps `zeropsYaml` free for what it is genuinely good at: a targeted per-deploy OVERRIDE. The
//      provider compiler still supports it (`ZeropsServiceSpec.zeropsYaml`); it is simply not how a
//      service's normal build is described.
//
// ── The rule for `envVariables` in here ────────────────────────────────────────────────────────────
//
// This file is COMMITTED and PLAINTEXT, and it is the same file for every installation. So it carries
// only values that are true for EVERY installation: ports, asset directories, and intra-project
// hostnames. Everything else is a service-level variable written through the env API (ADR-0004).
//
// Three categories are therefore deliberately ABSENT, and each setup lists its own below:
//
//   • per-installation configuration (public origins, cookie domains, authentication switches,
//     OIDC/email coordinates, admission lists, `ENVIRONMENT`) — set as service-level variables through the env API;
//   • every secret — set as service-level `envSecrets`, addressed by service, never through a document;
//   • **every `${service_variable}` reference to a DATA service** — `${db_connectionString}`,
//     `${storage_*}` and friends.
//
// That third category used to live here, on the reasoning that a reference is not a value: it points
// into the platform's variable store rather than carrying a credential. That reasoning is still sound
// and it is no longer sufficient, because a reference names a SERVICE — and which data services exist
// is exactly what differs between the `standard` and `light` tiers (`./topology.ts`). One committed
// file cannot say `${operationsdb_connectionString}` on behalf of a tier that has no `operationsdb`.
// So the file's own rule decides it: a data-service reference is not true for every installation, and
// it moves to the env API alongside the origins and the secrets.
//
// Verified live: a variable written through the env API resolves `${x_y}` at container start exactly as
// one written here does, so nothing is lost in the move.
//
// (The superseded `packages/iam/zerops.yaml` baked `ISSUER: https://iam.example.com`. That is
// per-installation, and a placeholder domain in a committed file is a value that boots wrong rather
// than not booting.)
//
// ── The canonical PostgreSQL DSN, wherever those variables are written ─────────────────────────────
//
// The URLs are not in this file, but their FORM is fabrika's to decide, so it is stated once here.
// Whichever service it names, a fabrika PostgreSQL URL on Zerops is written as:
//
//   ${<host>_connectionString}/${<host>_dbName}?sslmode=require
//
// Both suffixes are load-bearing, and both were settled on a live account rather than inferred:
//
//   • `connectionString` is `postgresql://${user}:${password}@${hostname}:${port}` — it carries no
//     database path, so without `/${…_dbName}` the driver falls back to the USER name. Every Zerops
//     PostgreSQL service names its database AND its user `db`, whatever the service hostname is
//     (checked on a service called `wu2db`), so the fallback is right — by an undocumented platform
//     convention rather than by anything fabrika states. Naming it removes the dependency.
//   • Port 5432 speaks TLS, which the published documentation denies. `sslmode=require` connects with
//     `pg_stat_ssl.ssl = true`; `verify-full` fails on the self-signed certificate. So `require` is
//     the strongest available mode, and pinning it beats inheriting whatever the client defaults to.
//     This is still the DIRECT port, not pgBouncer on 6432 — the migration lock is session-level.
//
// ── What a build container can and cannot see ──────────────────────────────────────────────────────
//
// Verified live, and it is not what the platform documentation implies: a build container sees NONE of
// its own service's env-API variables. Reading `${FOO}` in a `buildCommand` yields an empty string, with
// no error. The bridge is `build.envVariables: { FOO: '${RUNTIME_FOO}' }`, which does work, and which
// resolves nested references (a `RUNTIME_` lift of a variable that is itself `${db_connectionString}`
// arrives fully resolved). Only the proxy needs this, and it declares it explicitly below.

import type { ZeropsHealthCheckSpec, ZeropsReadinessCheckSpec, ZeropsYamlSetupSpec, ZeropsYamlSpec } from '@fabrika/provider-zerops'
import { FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'

// ── Readiness and liveness: two mechanisms, two questions ──────────────────────────────────────────
//
// `run.healthCheck` is LIVENESS. It runs for the life of the container and answers "is this process
// still serving?"; a failure pulls the container out of the balancer and eventually restarts it.
//
// `deploy.readinessCheck` is a DEPLOY GATE. It answers "may this new version take traffic at all?"; a
// version that never passes it fails the deploy and the previous version keeps serving. Verified on a
// live account: a build whose readiness path answered 503 ended `DEPLOY_FAILED` and never activated,
// while the previously active version stayed `ACTIVE` and serving.
//
// Both point at `/healthz`, and that is a decision rather than an economy. The question a deploy gate
// has to answer here is exactly "did this build come up and start answering HTTP" — the DATABASE
// dependency is already gated one step earlier, because `run.initCommands` runs the migrations and a
// non-zero exit there aborts the deploy before any check runs. A readiness path that queried Postgres
// would therefore add no gate and would fail deploys during an unrelated database blip.
//
// ── Why every duration is a quoted string ──────────────────────────────────────────────────────────
//
// The published `zerops.yaml` JSON schema types all six of these as `integer`. The platform refuses an
// integer — `cannot unmarshal !!int into time.Duration` — and bounds every one of them to [10s, 1h].
// Both verified live; see `docs/reference/zerops-platform.md`. `ZeropsDuration` encodes the first fact
// in the type system; the second is why nothing below is faster than 10s.

/**
 * Liveness timings, stated rather than defaulted.
 *
 * Probe at the platform's floor so a wedged container is noticed quickly; take it out of the balancer
 * after three consecutive misses; put it back after one success; and only RESTART after two minutes of
 * continuous failure. The asymmetry is the point — disconnecting is cheap and reversible, restarting is
 * neither, and a short `failureTimeout` turns one slow dependency into a rolling restart of every
 * container at once.
 */
const LIVENESS: Omit<ZeropsHealthCheckSpec, 'httpGet' | 'exec'> = {
	execPeriod: '10s',
	disconnectTimeout: '30s',
	recoveryTimeout: '10s',
	failureTimeout: '120s',
}

/**
 * Readiness timings for a service that migrates at container start.
 *
 * `failureTimeout` has to cover a cold container plus whatever `run.initCommands` does, which for these
 * three is a schema migration; three minutes is generous on purpose, because the cost of it being too
 * short is a failed deploy of a build that was fine.
 */
const READINESS_WITH_MIGRATIONS: Omit<ZeropsReadinessCheckSpec, 'httpGet' | 'exec'> = {
	retryPeriod: '10s',
	failureTimeout: '180s',
}

/** Readiness for a service with no init step: a static binary that either answers quickly or never will. */
const READINESS_IMMEDIATE: Omit<ZeropsReadinessCheckSpec, 'httpGet' | 'exec'> = {
	retryPeriod: '10s',
	failureTimeout: '60s',
}

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
 * Per-installation variables (env API): `FABRIKA_IAM_DATABASE_URL`
 * (`${db_connectionString}/${db_dbName}?sslmode=require` — the canonical form above, on the DIRECT
 * Postgres port 5432, never pgBouncer on 6432: the migration runner takes a session-level advisory
 * lock and transaction pooling does not preserve session state across statements),
 * `ENVIRONMENT`, `ISSUER` (this service's public origin; it is the `iss` of every minted token AND the
 * OIDC redirect base, so it must match the domain routed to the proxy in front of it),
 * `FABRIKA_IAM_ADMIN_ORIGINS` (a JSON array holding the CONSOLE's public
 * origin — the control plane's domain, which IAM cannot infer; an unset or empty value means no
 * browser may write to `/admin/*`, which closes the console's Access plane),
 * `HUMAN_EMAIL_DOMAINS`, `HUMAN_EMAILS`, `IAM_BOOTSTRAP_ADMINS`,
 * `FABRIKA_IAM_OIDC_ENABLED`, `FABRIKA_IAM_PASSWORD_ENABLED`, `FABRIKA_EMAIL_PROVIDER`, and
 * `FABRIKA_EMAIL_FROM` when email delivery is enabled. OIDC-enabled installations also set
 * `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_SCOPES`, `OIDC_REQUIRE_VERIFIED_EMAIL`.
 *
 * Secrets (`envSecrets`): `FABRIKA_IAM_SIGNING_KEYS` (ES256 private JWKs — an empty value is refused at
 * boot rather than silently issuing ephemeral tokens), `OIDC_CLIENT_SECRET` when OIDC is enabled,
 * `FABRIKA_EMAIL_RESEND_API_KEY` when Resend is enabled, `FABRIKA_IAM_RPC_KEY` (gates
 * the management `/rpc/*` surface; unset 404s it, which is the fail-closed default), `FABRIKA_IAM_PROXY_KEY`
 * (gates `/auth/mint/*`, which the proxy calls on the cold path — a SEPARATE secret by least privilege,
 * since the proxy is the only publicly routed component and must not also be able to write audit rows),
 * `FABRIKA_IAM_PROVISIONING_KEY`. Both shared secrets must be at least 32 characters; a shorter one fails
 * the boot rather than standing in front of an internet-reachable surface while looking configured.
 */
const iam: ZeropsYamlSetupSpec = {
	setup: 'iam',
	build: {
		// Bun on Alpine. `build.os` is deprecated in the published schema — the OS is part of the base id.
		base: ['alpine/bun@1.3'],
		buildCommands: ['bun install --frozen-lockfile'],
		deployFiles: WORKSPACE_DEPLOY_FILES,
		cache: ['node_modules'],
	},
	deploy: { readinessCheck: { httpGet: { port: 3000, path: '/healthz' }, ...READINESS_WITH_MIGRATIONS } },
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
		// Liveness only — it never touches Postgres. A health check that queried the database would let
		// one slow query restart every container at once. The deploy gate is `deploy.readinessCheck`.
		healthCheck: { httpGet: { port: 3000, path: '/healthz' }, ...LIVENESS },
		// The Cloudflare `scheduled` handler's replacement, running the same code path. `allContainers:
		// false` so a horizontally scaled service still prunes once.
		crontab: [{ timing: '0 3 * * *', command: 'bun packages/iam/src/node/prune.ts', allContainers: false }],
		envVariables: { PORT: '3000' },
	},
}

/**
 * The control plane — registry, run lifecycle, vault, webhook, and the dashboard SPA.
 *
 * Per-installation variables (env API): `FABRIKA_CONTROL_DATABASE_URL`
 * (`${db_connectionString}/${db_dbName}?sslmode=require`), the
 * four `FABRIKA_CONTROL_RUN_LOGS_*` coordinates of its object storage (`${storage_bucketName}`,
 * `${storage_apiUrl}`, `${storage_accessKeyId}`, `${storage_secretAccessKey}` — `S3BlobStore` uses
 * path-style addressing, which MinIO wants and R2/AWS accept, so one implementation serves both
 * platforms), `FABRIKA_CONTROL_RUN_LOGS_REGION`, `ENVIRONMENT`, `FABRIKA_CONTROL_DOMAIN`,
 * `FABRIKA_IAM_URL` (the public IAM issuer),
 * `OPERATIONS_ARTIFACT_ORIGIN` (the public proxy origin for source-map upload), `CLOUDFLARE_ACCOUNT_ID`,
 * `FABRIKA_CONTROL_BOOTSTRAP_ADMINS`, `FABRIKA_ZEROPS_CLIENT_ID`, `FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT`, and
 * `FABRIKA_ZEROPS_PROXY_IAM_URL` (the public IAM origin reachable from application projects).
 *
 * The `FABRIKA_` prefix on that last group is not cosmetic: Zerops RESERVES the bare `ZEROPS_` prefix
 * and rejects any custom variable using it (`userDataZeropsPrefixForbidden`), so the earlier names could
 * not be written through the env API at all — on the one platform they were named for.
 *
 * Secrets (`envSecrets`): `FABRIKA_IAM_RPC_KEY` (authenticates this process to IAM's RPC surface — the
 * same value IAM holds), `FABRIKA_CONTROL_VAULT_KEY` (the vault KEK; its loss is unrecoverable by design),
 * `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `CLOUDFLARE_API_TOKEN`,
 * `FABRIKA_IAM_PROVISIONING_KEY`, `FABRIKA_ZEROPS_PROXY_IAM_KEY` (the same credential IAM receives as
 * `FABRIKA_IAM_PROXY_KEY`), `OPERATIONS_SYNC_KEY` (the same catalog credential Operations receives),
 * and — when this control plane deploys to Zerops — `FABRIKA_ZEROPS_ACCESS_TOKEN`. Give it a Zerops
 * INTEGRATION token scoped to the projects this installation manages (`POST
 * /client/{id}/integration-token`, client role `NO_ACCESS`, per-project role `ADMIN`), never a personal
 * access token: a personal token carries account-wide admin rights and is the single most dangerous
 * thing an installation could hold.
 *
 * There is NO runner service anywhere in this topology, and that is ADR-0003, not an omission: Zerops
 * has its own CI, so a deploy here is five HTTP calls made by this process.
 */
const control: ZeropsYamlSetupSpec = {
	setup: 'control',
	build: {
		base: ['alpine/bun@1.3'],
		buildCommands: ['bun install --frozen-lockfile', 'bun run --filter @fabrika/dashboard build'],
		deployFiles: WORKSPACE_DEPLOY_FILES,
		cache: ['node_modules'],
	},
	deploy: { readinessCheck: { httpGet: { port: 3000, path: '/healthz' }, ...READINESS_WITH_MIGRATIONS } },
	run: {
		base: 'alpine/bun@1.3',
		initCommands: ['bun packages/control/src/node/migrate.ts'],
		start: 'bun packages/control/src/node/server.ts',
		ports: [{ port: 3000, httpSupport: true }],
		healthCheck: { httpGet: { port: 3000, path: '/healthz' }, ...LIVENESS },
		crontab: [{ timing: '*/5 * * * *', command: 'bun packages/control/src/node/cron.ts', allContainers: false }],
		envVariables: {
			PORT: '3000',
			FABRIKA_CONTROL_ASSETS_DIR: 'packages/dashboard/dist',
			// Intra-project transport for management RPC. `FABRIKA_IAM_URL` is deliberately absent here:
			// it is the public token issuer and is supplied per installation through the env API.
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_OPERATIONS_URL: 'http://operations:3000',
		},
	},
}

/**
 * Operations is private inside the platform project. The proxy is its only public ingress and its
 * manifest must route only `/api/{projectId}/envelope/` for the configured public hostname.
 *
 * Per-installation variables (env API): `FABRIKA_OPERATIONS_DATABASE_URL`, the five
 * `FABRIKA_OPERATIONS_BLOB_*` coordinates, `ENVIRONMENT`, `FABRIKA_OPERATIONS_PUBLIC_HOST` and
 * `FABRIKA_IAM_URL` (the public IAM issuer). `FABRIKA_OPERATIONS_DATABASE_URL` takes the canonical
 * form above. On the `standard` tier the data references are `${operationsdb_*}` and
 * `${operationsstorage_*}`; on `light` they are `${db_*}` and `${storage_*}`, which is precisely why
 * they cannot be written here.
 *
 * Secrets (`envSecrets`): `OPERATIONS_SYNC_KEY`, shared only with control for catalog projection, and
 * `FABRIKA_IAM_RPC_KEY`, used only for Operations → IAM management RPC.
 */
const operations: ZeropsYamlSetupSpec = {
	setup: 'operations',
	build: {
		base: ['alpine/bun@1.3'],
		buildCommands: ['bun install --frozen-lockfile'],
		deployFiles: WORKSPACE_DEPLOY_FILES,
		cache: ['node_modules'],
	},
	deploy: { readinessCheck: { httpGet: { port: 3000, path: '/healthz' }, ...READINESS_WITH_MIGRATIONS } },
	run: {
		base: 'alpine/bun@1.3',
		initCommands: ['bun packages/operations/src/node/migrate.ts'],
		start: 'bun packages/operations/src/node/server.ts',
		ports: [{ port: 3000, httpSupport: true }],
		healthCheck: { httpGet: { port: 3000, path: '/healthz' }, ...LIVENESS },
		crontab: [{ timing: '* * * * *', command: 'bun packages/operations/src/node/cron.ts', allContainers: false }],
		envVariables: {
			PORT: '3000',
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
 * this service before each app deploy (`packages/control/src/node/zerops-proxy.ts`).
 *
 * That live-account fact is now settled, and the answer was the bad one: **a build container sees none
 * of its service's env-API variables.** Read directly, `${FABRIKA_PROXY_MANIFEST_JSON}` in a build
 * command is the empty string — no error, no warning. Left uncorrected, every proxy build would have
 * written an empty manifest, failed `generate-config.ts`, and made this service undeployable on Zerops.
 *
 * The fix is the `build.envVariables` declaration below rather than the move into `run.initCommands`
 * this header used to anticipate: `${RUNTIME_x}` lifts a service's own runtime variable into its build
 * context, and it resolves nested references too. The delivery channel and the fail-closed parser are
 * unchanged, which is what that contingency promised.
 *
 * What IS structural: missing or malformed JSON makes `generate-config.ts` exit non-zero, so the
 * pipeline fails and the previous version keeps serving. A valid empty app list generates only the
 * terminal 404 route, and the auth service denies every forwarded request.
 */
const proxyManifestReference = `\${${FABRIKA_PROXY_MANIFEST_JSON}}`

/**
 * The proxy's public listeners.
 *
 * Routing is by HOST — one app owns one hostname, and `assertUniqueHosts` refuses to let two apps share
 * one so that Caddy's route order can never decide which app answers. A production installation gets
 * those hostnames from custom domains bound to the project's balancer, and needs exactly ONE listener:
 * every domain arrives on the same port and the Host header decides.
 *
 * A `zerops-subdomain` installation has no such source of names. Zerops mints one generated hostname per
 * HTTP PORT, so on that path a port IS a hostname — and the number of listeners is the number of
 * distinct public hosts the installation can ever serve. Three are the platform's own (IAM's JWKS and
 * OIDC redirect, the control dashboard, Operations ingest); the rest are a fixed pool of APPLICATION
 * slots, and running out of them is what caps a light-tier installation rather than any resource limit.
 *
 * That ceiling is the honest cost of the subdomain path and the reason it is not the production one.
 * A custom-domain installation ignores all of this: with `enableSubdomainAccess: false` nothing here is
 * published, the extra listeners answer the same host-matched routes, and an unknown Host still falls
 * through to the terminal 404. One setup serves both tiers rather than a second that must be kept in
 * step with this one.
 *
 * 8081 is deliberately absent: it is the health listener, which is never published.
 */
const PROXY_PUBLIC_PORTS = [8080, 8082, 8083, 8084, 8085, 8086]

/** Liveness only, on its own unpublished listener. */
const PROXY_HEALTH_PORT = 8081

const proxy: ZeropsYamlSetupSpec = {
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
		// The ONE variable this build reads that is not a constant, lifted out of the runtime store because
		// a build container cannot see the runtime store any other way (see the header). Same name on both
		// sides is safe here and is not the `FOO: ${FOO}` self-shadow trap: the `RUNTIME_` prefix makes the
		// right-hand side a different key from the left.
		envVariables: { [FABRIKA_PROXY_MANIFEST_JSON]: `\${RUNTIME_${FABRIKA_PROXY_MANIFEST_JSON}}` },
		// CGO off makes the binary static, which is what lets it run on Alpine/musl.
		prepareCommands: ['CGO_ENABLED=0 GOBIN=/tmp/gobin go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.10.2'],
		buildCommands: [
			'bun install --frozen-lockfile',
			// See the header: the manifest arrives as a service variable because the driver has no
			// filesystem. `printf` rather than `echo` so a leading `-` or a backslash survives intact.
			`printf %s "${proxyManifestReference}" > ./proxy.manifest.json`,
			// Missing/malformed JSON fails the build; an empty app list emits only deny/404 routes.
			`bun run packages/proxy/src/generate-config.ts ./proxy.manifest.json ./caddy.json --auth-upstream 127.0.0.1:9000 --listen ${
				PROXY_PUBLIC_PORTS.map((port) => `:${port}`).join(',')
			}`,
			'bun build --compile --target=bun-linux-x64-musl ./packages/proxy/src/main.ts --outfile ./fabrika-proxy',
			'cp /tmp/gobin/caddy ./caddy',
		],
		deployFiles: ['caddy', 'fabrika-proxy', 'caddy.json', 'proxy.manifest.json', 'packages/proxy/start.sh'],
		cache: ['node_modules', '/root/go/pkg/mod'],
	},
	// The service this gate matters most for: it is the only publicly routed one in either project, so a
	// version that builds but cannot serve would take the whole project's public surface with it.
	deploy: { readinessCheck: { httpGet: { port: PROXY_HEALTH_PORT, path: '/healthz' }, ...READINESS_IMMEDIATE } },
	run: {
		// Alpine custom runtime: an arbitrary static binary with an arbitrary start command. No TLS config
		// anywhere on purpose — the project's L7 balancer terminates TLS, so Caddy serves plain HTTP behind
		// it and needs no ACME, no certificate storage and therefore no disk.
		base: 'alpine@3.21',
		ports: PROXY_PUBLIC_PORTS.map((port) => ({ port, httpSupport: true })),
		// Deliberately NOT one of the public ports: a health path on a public listener would be one path per
		// proxy that answers 200 without consulting the gates, and would shadow an app path of the same name.
		healthCheck: { httpGet: { port: PROXY_HEALTH_PORT, path: '/healthz' }, ...LIVENESS },
		envVariables: {
			FABRIKA_PROXY_MANIFEST: '/var/www/proxy.manifest.json',
			// Loopback only; Caddy dials it. It must never be routable.
			FABRIKA_PROXY_PORT: '9000',
		},
		start: 'sh /var/www/packages/proxy/start.sh',
	},
}

/** The repository-root `zerops.yaml`, in the order the setups appear in it. */
export const fabrikaZeropsYaml: ZeropsYamlSpec = { zerops: [iam, operations, control, proxy] }
