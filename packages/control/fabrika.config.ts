// fabrika's OWN Cloudflare deploy surface. fabrika is just another app the control
// plane deploys: this single file is the source of truth for fabrika's Cloudflare resource graph, its
// authz vocabulary, and its deploy pipeline. The public proxy enforces the ordered path gates before
// the application Worker; the application keeps object authorization and a defence-in-depth check.
// The Cloudflare provider CLI and scripts/bootstrap.ts load THIS to self-deploy.
//
// Local dev still uses oblaka directly: `oblaka.ts` is a thin shim that imports `buildControlWorker`
// from here and feeds it to oblaka's `define`, so `bunx oblaka oblaka.ts` (wrangler.jsonc generation)
// and `wrangler d1 migrations apply DB --local` keep working unchanged. The resource graph lives in
// ONE place; the two entry points differ only in what surrounds it.
//
// Secrets are never inlined: the GitHub App key/webhook secret + the M4 vault key are declared by
// NAME in `pipeline.secrets` and provisioned out-of-band (`wrangler secret put` / `.dev.vars`).

import type { AppGates, AppSchema } from '@fabrika/auth'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import { environmentAliases } from '@fabrika/platform'
import {
	createCloudflareProxyWorker,
	D1Database,
	defineApp,
	Queue,
	R2Bucket,
	type ResourceContext,
	ServiceReference,
	Worker,
} from '@fabrika/provider-cloudflare'
import { ACTIONS, SCOPES, VOZKA_APP_ID } from './src/actions'
import { CONTROL_GATES } from './src/iam'

const CONTROL_PROXY_GATES: AppGates = {
	rules: [
		{ path: '/healthz', kind: 'public' },
		{ path: '/api/health', kind: 'public' },
		{ path: '/webhooks/github', kind: 'public' },
		{ path: '/iam/admin', kind: 'service' },
		{ path: '/iam/admin', kind: 'human' },
		{ path: '/iam/admin/*', kind: 'service' },
		{ path: '/iam/admin/*', kind: 'human' },
		{ path: '/operations/api', kind: 'service' },
		{ path: '/operations/api', kind: 'human' },
		{ path: '/operations/api/*', kind: 'service' },
		{ path: '/operations/api/*', kind: 'human' },
		...CONTROL_GATES.rules,
		{ path: '/*', kind: 'human' },
	],
}

/**
 * Build fabrika's full Cloudflare resource graph for one environment. This is the SINGLE source of the
 * graph — consolidated out of the old `oblaka.ts`. Both the provider deploy path (via `defineApp`
 * below) and the local-dev `oblaka.ts` shim call this, so the two never drift.
 *
 * `ctx.domain` (from `FABRIKA_CONTROL_DOMAIN` on the provider deploy path) is surfaced as a runtime var so the
 * Worker can build absolute URLs (e.g. webhook callbacks); it's empty locally, where oblaka's
 * `define` has no domain to pass.
 */
export const buildControlApplicationWorker = (ctx: ResourceContext): Worker => {
	const { env, domain } = ctx
	const isLocal = env === 'local'
	const operationsArtifactOrigin = process.env['OPERATIONS_ARTIFACT_ORIGIN']
	const bootstrapAdmins = environmentAliases.read({
		FABRIKA_CONTROL_BOOTSTRAP_ADMINS: process.env['FABRIKA_CONTROL_BOOTSTRAP_ADMINS'],
		VOZKA_BOOTSTRAP_ADMINS: process.env['VOZKA_BOOTSTRAP_ADMINS'],
	}, {
		canonical: 'FABRIKA_CONTROL_BOOTSTRAP_ADMINS',
		legacy: 'VOZKA_BOOTSTRAP_ADMINS',
	}) ?? '[]'
	const iamUrl = environmentAliases.read({
		FABRIKA_IAM_URL: process.env['FABRIKA_IAM_URL'],
		PROPUSTKA_URL: process.env['PROPUSTKA_URL'],
	}, { canonical: 'FABRIKA_IAM_URL', legacy: 'PROPUSTKA_URL' }) ?? ''

	return new Worker({
		dir: '.',
		name: 'vozka',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat'],
		compatibility_date: '2025-05-25',
		workers_dev: false,
		// Public routing belongs to the proxy Worker. The application is reached through its APP service binding.
		routes: [],
		observability: { enabled: true },
		// Cron trigger driving `scheduled` (src/index.ts): poll PUBLIC repos (no GitHub App install)
		// for new commits every 5 minutes — the pull-based deploy trigger alongside the push webhook.
		triggers: { crons: ['*/5 * * * *'] },
		assets: {
			// The dashboard SPA (built by @fabrika/dashboard, M3b) served for non-API paths.
			directory: '../dashboard/dist',
			binding: 'ASSETS',
			not_found_handling: 'single-page-application',
		},
		vars: {
			ENVIRONMENT: env,
			// The public domain this stage serves on (drives absolute URLs); empty when unknown.
			FABRIKA_CONTROL_DOMAIN: domain ?? '',
			// Selects the auth path in src/iam.ts: 'true' (local) → a synthesized dev-persona AuthContext
			// (no IAM Worker); '' (off-local) → IAM-backed auth over the service binding.
			DEV: isLocal ? 'true' : '',
			// Bootstrap-admin fallback (src/iam.ts): a JSON array of emails authorized as admin even
			// when IAM denies / the binding isn't wired yet. Empty by default; the bootstrap
			// script (scripts/bootstrap.ts) sets the first operator's email here for initial bring-up.
			FABRIKA_CONTROL_BOOTSTRAP_ADMINS: bootstrapAdmins,
			// The selected Cloudflare provider's account id and IAM origin. The composition root
			// injects them into provider jobs without persisting credentials in the registry.
			CLOUDFLARE_ACCOUNT_ID: process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '',
			FABRIKA_IAM_URL: iamUrl,
			...(operationsArtifactOrigin === undefined || operationsArtifactOrigin === ''
				? {}
				: { OPERATIONS_ARTIFACT_ORIGIN: operationsArtifactOrigin }),
			// The GitHub App's numeric id (public, not a secret) — it's the `iss` of the App JWT that mints
			// installation tokens to clone PRIVATE app repos. The PEM key is a `pipeline.secret`; the id is
			// just config, so it rides as a var. Without it the JWT iss is empty and GitHub answers 401.
			GITHUB_APP_ID: process.env['GITHUB_APP_ID'] ?? '',
		},
		bindings: {
			// Run logs + terminal status, keyed by run id (runs/<id>/logs.ndjson, runs/<id>/status.json).
			RUN_LOGS: new R2Bucket({ name: 'vozka-run-logs' }),
			// Registry + run history + the per-app-env deploy LOCKS: a `deploy_locks` row per `<app>:<env>`
			// serializes deploys of the same target (it replaced a Durable Object — see src/deploy-locks.ts),
			// so two triggers can't race on cf-state / wrangler / IAM. D1 is region-specific → pinned
			// to EU West. Migrations in ./migrations.
			DB: new D1Database({ name: 'vozka', migrationsDir: './migrations', locationHint: 'weur' }),
			// Deploy job queue: producer (POST /webhooks/github + triggerDeploy) + consumer (queue()).
			// A run is enqueued by id; the consumer loads it from D1, assembles the job, and runs it.
			DEPLOY_QUEUE: new Queue({
				name: 'vozka-deploy',
				binding: 'both',
				consumer: {
					// One deploy at a time per message; a deploy is long, so a small batch + generous
					// retry budget. The lifecycle consumer is idempotent (status-guarded), so a redeliver
					// is a safe no-op.
					maxBatchSize: 1,
					maxRetries: 3,
					retryDelay: 30,
				},
			}),
			// Off-local service bindings (local dev has neither): IAM (src/iam.ts uses
			// FakeIamClient locally, DEV='true') + vozka-runner, the deploy executor the queue consumer
			// hands each run to (RUNNER_SVC.startRun). vozka-runner is its OWN worker so a deploy of fabrika
			// never resets the container running it — deployed out-of-band (packages/runner-cloudflare bootstrap).
			...(isLocal ? {} : {
				IAM: new ServiceReference('propustka-worker'),
				OPERATIONS: new ServiceReference('operations'),
				RUNNER_SVC: new ServiceReference('vozka-runner'),
			}),
		},
	})
}

export const buildControlWorker = (ctx: ResourceContext): Worker => {
	const iamUrl = environmentAliases.read({
		FABRIKA_IAM_URL: process.env['FABRIKA_IAM_URL'],
		PROPUSTKA_URL: process.env['PROPUSTKA_URL'],
	}, { canonical: 'FABRIKA_IAM_URL', legacy: 'PROPUSTKA_URL' }) ?? ''
	return createCloudflareProxyWorker({
		name: 'vozka-proxy',
		app: buildControlApplicationWorker(ctx),
		appId: VOZKA_APP_ID,
		appHost: ctx.domain ?? 'localhost',
		gates: CONTROL_PROXY_GATES,
		domain: ctx.domain,
		iamUrl,
	})
}

/**
 * fabrika's authz vocabulary, reconciled into IAM so the admin UI can render real choices. Kept
 * in sync with the runtime by importing the SAME constants the Worker enforces against (src/actions.ts)
 * — the action strings and scope dimensions here are exactly what `auth.can(action, scope)` checks.
 *
 * Roles (origin='app'):
 *   - operator → `deploy.*`  (trigger + read any deploy; no registry/secret management)
 *   - admin    → `*`         (every action, every scope)
 */
const schema: AppSchema = {
	// The two scope dimensions fabrika authorizes within (flat + independent — see src/actions.ts).
	scopes: [
		{ type: SCOPES.APP, label: 'App' },
		{ type: SCOPES.ENVIRONMENT, label: 'Environment' },
	],
	// The concrete actions fabrika enforces — imported from src/actions.ts so there is no drift.
	actions: [
		{ action: ACTIONS.DEPLOY_TRIGGER, description: 'Trigger a deploy run' },
		{ action: ACTIONS.DEPLOY_READ, description: 'Read deploy runs + their logs' },
		{ action: ACTIONS.APP_MANAGE, description: 'Manage the app registry (apps + app_envs)' },
		{ action: ACTIONS.NAMESPACE_MANAGE, description: 'Manage deployment namespaces' },
		{ action: ACTIONS.SECRET_MANAGE, description: 'Manage secret values + their references' },
		{ action: OPERATIONS_ACTIONS.READ, description: 'Read Operations errors and activity' },
		{ action: OPERATIONS_ACTIONS.TRIAGE, description: 'Triage Operations errors' },
		{ action: OPERATIONS_ACTIONS.MANAGE, description: 'Manage Operations sources, alerts, and retention' },
	],
	roles: {
		operator: {
			name: 'Operator',
			description: 'Trigger and read any deploy (no registry or secret management).',
			// `deploy.*` covers deploy.trigger + deploy.read (prefix wildcard).
			permissions: ['deploy.*', 'operations.*'],
		},
		admin: {
			name: 'Admin',
			description: 'Full access to every vozka action in every scope.',
			permissions: ['*'],
		},
	},
}

export default defineApp({
	id: VOZKA_APP_ID,
	resources: buildControlWorker,
	schema,
	pipeline: {
		// fabrika's Worker source lives alongside this config (packages/control).
		workerDir: '.',
		// Build the dashboard SPA into ../dashboard/dist (the ASSETS directory) before deploy.
		build: 'bun run --filter @fabrika/dashboard build',
		// Runtime Worker secrets fabrika needs, provisioned via `wrangler secret put` at deploy:
		//   - FABRIKA_CONTROL_VAULT_KEY — the M4 vault master key (KEK) for the encrypted D1 secret vault.
		//   - GITHUB_APP_PRIVATE_KEY  — the GitHub App PEM key (signs the App JWT for install tokens).
		//   - GITHUB_WEBHOOK_SECRET   — HMAC-verifies inbound POST /webhooks/github.
		//   - CLOUDFLARE_API_TOKEN    — the account-wide CF token fabrika deploys every app with (single
		//                               account → one token; same token that authenticated THIS deploy).
		//   - FABRIKA_IAM_PROVISIONING_KEY — fabrika's seeded IAM provisioning `px_` key, injected into
		//                               deploys that reconcile schema. Omit at deploy to run without reconcile.
		// Their VALUES are read from the environment by name at deploy time (never inlined here).
		secrets: [
			'FABRIKA_CONTROL_VAULT_KEY',
			'GITHUB_APP_PRIVATE_KEY',
			'GITHUB_WEBHOOK_SECRET',
			'CLOUDFLARE_API_TOKEN',
			'FABRIKA_IAM_PROVISIONING_KEY',
			'OPERATIONS_SYNC_KEY',
		],
	},
})
