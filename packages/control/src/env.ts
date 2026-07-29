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
import type { AssetServer, BlobStore, JobQueue, SqlDatabase } from '@fabrika/platform'
import type { DeployJobMessage } from './run-lifecycle'

export interface Env {
	/**
	 * Registry (apps/app_envs/app_secrets/app_vars) + run history + the vault + the per-app-env deploy
	 * locks — ONE database. D1 on Workers, Postgres on Bun. Schema: `migrations/` (SQLite/D1) and
	 * `migrations-postgres/` (Postgres).
	 */
	DB: SqlDatabase
	/** Control-plane SPA static assets, served for non-`/api/*`, non-webhook paths. */
	ASSETS: AssetServer
	/** Run logs + terminal status, keyed by run id. */
	RUN_LOGS: BlobStore
	/** Deploy job PRODUCER (trigger/webhook/poll). The consumer is per-runtime — see the header. */
	DEPLOY_QUEUE: JobQueue<DeployJobMessage>
	/**
	 * propustka IAM — authorization + audit. A service binding on Workers; an `HttpIamRpc`
	 * (`@fabrika/auth`) over the project's private network in a process. OPTIONAL because the local dev
	 * path (`DEV='true'`) uses a persona fake and never touches it.
	 */
	IAM?: IamRpc

	// ── Vars ──────────────────────────────────────────────────────────────────
	ENVIRONMENT: string
	/** 'true' locally → the dev-persona AuthContext (no propustka); '' off-local → `PropustkaAuth`. */
	DEV: string
	/**
	 * Public domain this stage serves on (drives absolute URLs); empty when unknown. Also the authority
	 * on whether the BROWSER spoke HTTPS — see `secureCookies` in src/iam.ts, which cannot use the
	 * request's own protocol behind a TLS-terminating balancer.
	 */
	VOZKA_DOMAIN?: string
	/**
	 * propustka IAM base URL. It is also the `PropustkaAuth` issuer used to authenticate control-plane
	 * callers. Provider composition roots may pass it into their schema reconciliation capability.
	 */
	PROPUSTKA_URL?: string
	/**
	 * JSON array of bootstrap-admin emails (normally `'[]'`). When a caller's email is in this list,
	 * src/iam.ts authorizes them as admin even if propustka denies / IAM isn't wired yet — the escape
	 * hatch for the FIRST operator before propustka knows about fabrika. Mirrors propustka's own
	 * IAM_BOOTSTRAP_ADMINS. Set by scripts/bootstrap.ts for initial bring-up; emptied afterwards.
	 */
	VOZKA_BOOTSTRAP_ADMINS?: string

	// ── Secrets (provisioned out-of-band; never in oblaka.ts `vars` / zerops.yaml `envVariables`) ──
	/** GitHub App webhook secret — HMAC-verifies inbound `POST /webhooks/github`. */
	GITHUB_WEBHOOK_SECRET?: string
	/** GitHub App id (numeric string) — signs the App JWT for installation-token minting. */
	GITHUB_APP_ID?: string
	/** GitHub App PEM private key — signs the App JWT. NEVER logged. */
	GITHUB_APP_PRIVATE_KEY?: string
	/**
	 * The seeded propustka provisioning bearer. Core accepts it as a machine bootstrap credential;
	 * provider composition roots may also use it for schema reconciliation.
	 */
	PROPUSTKA_PROVISIONING_KEY?: string
	/**
	 * The vault MASTER key (KEK) for the encrypted secret vault — 32 raw bytes, base64. Seals every
	 * per-value data key (src/vault.ts). Provisioned out-of-band, once per environment:
	 *   `head -c 32 /dev/urandom | base64 | wrangler secret put VOZKA_VAULT_KEY`
	 * (`.dev.vars` locally, an `envSecret` on Zerops). OPTIONAL on the type because the env/literal dev
	 * path never needs it; the vault management API + `vault:` ref resolution fail loudly when absent.
	 */
	VOZKA_VAULT_KEY?: string
}
