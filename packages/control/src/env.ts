/**
 * The control plane's runtime surface: its capability handles plus vars/secrets. Single source of
 * truth — every other file imports from here and never re-declares the shape.
 *
 * EVERY HANDLE IS A PORT (`@fabrika/platform`), not a Cloudflare binding, which is what lets ONE `Env`
 * serve both entrypoints. Two are satisfied STRUCTURALLY by the binding, while the Worker adapts the
 * other two in `platform-cf.ts`:
 *
 *   DB           SqlDatabase        ← `D1Database` satisfies it structurally (the port's shape is D1's)
 *   ASSETS       AssetServer        ← `Fetcher` satisfies it structurally
 *   RUN_LOGS     BlobStore          ← `R2Bucket.put` resolves `R2Object | null`, so it needs an adapter
 *   DEPLOY_QUEUE JobQueue           ← `Queue.send` resolves `QueueSendResponse`, so it needs an adapter
 *
 * The CONSUMER side of the queue is deliberately absent: on Workers it is an inversion of control the
 * platform drives (`queue()`), in a process it is a loop fabrika owns. See the header of
 * `@fabrika/platform-node`'s `job-queue-postgres.ts` for why that has no honest common supertype.
 *
 * Everything else here is a plain string, so it comes equally from `wrangler` vars or `process.env`.
 */

import type { IamRpc } from '@fabrika/auth'
import type { AssetServer, BlobStore, HttpService, JobQueue, SqlDatabase, WaitUntil } from '@fabrika/platform'
import type { ControlRepositories } from './db'
import type { DeployJobMessage } from './run-lifecycle'

export interface Env {
	/**
	 * Registry (apps/app_envs/app_secrets/app_vars) + run history + the vault + the per-app-env deploy
	 * locks — ONE database. D1 on Workers, Postgres on Bun. Schema: `migrations/` (SQLite/D1) and
	 * `migrations-postgres/` (Postgres).
	 */
	DB: SqlDatabase
	/** Persistence capabilities selected by this runtime's composition root. */
	REPOSITORIES: ControlRepositories
	/** Control-plane SPA static assets, served for non-`/api/*`, non-webhook paths. */
	ASSETS: AssetServer
	/** Run logs + terminal status, keyed by run id. */
	RUN_LOGS: BlobStore
	/** Deploy job PRODUCER (trigger/webhook/poll). The consumer is per-runtime — see the header. */
	DEPLOY_QUEUE: JobQueue<DeployJobMessage>
	/** Runtime-specific supervised background work (`ctx.waitUntil` or the Bun task tracker). */
	WAIT_UNTIL: WaitUntil
	/**
	 * IAM — authorization + audit. A service binding on Workers; an `HttpIamRpc`
	 * (`@fabrika/auth`) over the project's private network in a process. OPTIONAL because the local dev
	 * path (`DEV='true'`) uses a persona fake and never touches it.
	 */
	IAM?: IamRpc
	/**
	 * IAM's HTTP admin surface. Control only transports `/iam/admin/*` requests through this port;
	 * IAM still authenticates, authorizes, and audits every operation.
	 */
	IAM_ADMIN?: HttpService
	/** Private Operations transport shared by catalog projection and the console operator gateway. */
	OPERATIONS?: HttpService

	// ── Vars ──────────────────────────────────────────────────────────────────
	ENVIRONMENT: string
	/** 'true' locally → the dev-persona AuthContext (no IAM service); '' off-local → IAM-backed auth. */
	DEV: string
	/**
	 * Public domain this stage serves on (drives absolute URLs); empty when unknown. Also the CSRF
	 * guard's authority on the console's own origin — see `controlPublicOrigin` in src/iam.ts, which
	 * cannot use the request's own protocol behind a TLS-terminating balancer.
	 */
	FABRIKA_CONTROL_DOMAIN?: string
	/**
	 * IAM base URL. It is also the issuer used to authenticate control-plane
	 * callers. Provider composition roots may pass it into their schema reconciliation capability.
	 */
	FABRIKA_IAM_URL?: string
	/**
	 * JSON array of bootstrap-admin emails (normally `'[]'`). When a caller's email is in this list,
	 * src/iam.ts authorizes them as admin even if IAM denies / is not wired yet — the escape
	 * hatch for the FIRST operator before IAM knows about fabrika. Mirrors IAM's own
	 * IAM_BOOTSTRAP_ADMINS. Set by scripts/bootstrap.ts for initial bring-up; emptied afterwards.
	 */
	FABRIKA_CONTROL_BOOTSTRAP_ADMINS?: string

	// ── Secrets (provisioned out-of-band; never in oblaka.ts `vars` / zerops.yaml `envVariables`) ──
	/** GitHub App webhook secret — HMAC-verifies inbound `POST /webhooks/github`. */
	GITHUB_WEBHOOK_SECRET?: string
	/** GitHub App id (numeric string) — signs the App JWT for installation-token minting. */
	GITHUB_APP_ID?: string
	/** GitHub App PEM private key — signs the App JWT. NEVER logged. */
	GITHUB_APP_PRIVATE_KEY?: string
	/**
	 * The seeded IAM provisioning bearer. Core accepts it as a machine bootstrap credential;
	 * provider composition roots may also use it for schema reconciliation.
	 */
	FABRIKA_IAM_PROVISIONING_KEY?: string
	/** Private Control → Operations catalog bearer. Never exposed to the browser or logged. */
	OPERATIONS_SYNC_KEY?: string
	/** Public Operations origin used only for scoped release-artifact upload URLs. */
	OPERATIONS_ARTIFACT_ORIGIN?: string
	/**
	 * The vault MASTER key (KEK) for the encrypted secret vault — 32 raw bytes, base64. Seals every
	 * per-value data key (src/vault.ts). Provisioned out-of-band, once per environment:
	 *   `head -c 32 /dev/urandom | base64 | wrangler secret put FABRIKA_CONTROL_VAULT_KEY`
	 * (`.dev.vars` locally, an `envSecret` on Zerops). OPTIONAL on the type because the env/literal dev
	 * path never needs it; the vault management API + `vault:` ref resolution fail loudly when absent.
	 */
	FABRIKA_CONTROL_VAULT_KEY?: string
}
