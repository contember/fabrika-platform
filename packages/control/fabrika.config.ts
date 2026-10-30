// fabrika's OWN Cloudflare deploy surface. fabrika is just another app the control
// plane deploys: this single file is the source of truth for fabrika's Cloudflare resource graph, its
// authz vocabulary, and its deploy pipeline. The public proxy decides from the console's service table before
// the application Worker; the application keeps object authorization and a defence-in-depth check.
// The Cloudflare provider CLI and scripts/bootstrap.ts load THIS to self-deploy.
//
// Local dev still uses oblaka directly: `oblaka.ts` is a thin shim that imports `buildControlWorker`
// from here and feeds it to oblaka's `define`, so `bunx oblaka oblaka.ts` (wrangler.jsonc generation)
// and `wrangler d1 migrations apply DB --local` keep working unchanged. The resource graph lives in
// ONE place; the two entry points differ only in what surrounds it.
//
// Secrets are never inlined: the vault key and the platform credentials are declared by NAME in
// `pipeline.secrets` and provisioned out-of-band (`wrangler secret put` / `.dev.vars`). GitHub App keys
// are not among them: each source connection's key lives in the vault (ADR-0029).

import { CONTROL_APP_ID } from '@fabrika/control-contract'
import { EMAIL_PROVIDER_VARIABLE, NO_EMAIL_PROVIDER, pickEmailEnvironment } from '@fabrika/email'
import { builtinEmailProviders } from '@fabrika/email/providers'
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
import { serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { controlSchema } from './fabrika.schema'
import { controlServiceContract } from './fabrika.service'
import { CLOUDFLARE_MAIL_REMEDY, type InstallationMail, readInstallationMail } from './src/mail-transport'

/**
 * IAM's origin — the issuer both this Worker and the proxy in front of it verify tokens against.
 * Locally it falls back to `packages/iam`'s own `bun run dev` port, because there is no environment in
 * which the issuer is optional: `createIam` refuses to build without it.
 */
const LOCAL_IAM_URL = 'http://localhost:18191'

const resolveIamUrl = (isLocal: boolean): string => process.env['FABRIKA_IAM_ISSUER'] ?? (isLocal ? LOCAL_IAM_URL : '')

type EnvironmentSource = Readonly<Record<string, string | undefined>>

/** The installation's mail transport, from the same `FABRIKA_EMAIL_*` the workflow hands IAM. */
const installationMail = (source: EnvironmentSource): InstallationMail =>
	readInstallationMail(pickEmailEnvironment(source), builtinEmailProviders, CLOUDFLARE_MAIL_REMEDY)

/**
 * The transport's plain Worker vars: the provider, the sender and the provider's non-secret variables, or
 * `FABRIKA_EMAIL_PROVIDER=none`. Control hands the set to the deploys whose contract has a `mailer: 'installation'` job.
 * An invalid set refuses this deploy, naming variables only (IAM's stage refuses the same set first). Locally none, and
 * no check: the local Worker hands no transport, and the committed wrangler.jsonc stays the same whatever the shell holds.
 */
export const controlEmailVars = (isLocal: boolean, source: EnvironmentSource = process.env): Record<string, string> => {
	if (isLocal) return {}
	const mail = installationMail(source)
	if (mail.kind === 'invalid') throw new Error(`the installation's mail transport is invalid: ${mail.reason}`)
	if (mail.kind === 'none') return { [EMAIL_PROVIDER_VARIABLE]: NO_EMAIL_PROVIDER }
	const { variables, secretNames } = mail.transport
	return Object.fromEntries(Object.entries(variables).filter(([name]) => !secretNames.has(name)))
}

/**
 * The provider's credentials, which the deploy writes as Worker secrets, never into plain vars. Read when this module
 * loads, before the environment is known, so it never throws: an invalid set names no secret, and `controlEmailVars`
 * refuses that deploy when the resource graph is built, before any secret is written.
 */
export const controlEmailSecrets = (source: EnvironmentSource = process.env): string[] => {
	const mail = installationMail(source)
	return mail.kind === 'transport' ? [...mail.transport.secretNames].sort() : []
}

/**
 * Runtime Worker secrets fabrika needs, provisioned via `wrangler secret put` at deploy. Their VALUES are read from the
 * environment by name at deploy time (never inlined here):
 *   - FABRIKA_CONTROL_VAULT_KEY — the vault master key (KEK) for the encrypted D1 secret vault, which also holds every
 *     GitHub source connection's App key.
 *   - CLOUDFLARE_API_TOKEN — the account-wide CF token fabrika deploys every app with (single account → one token; the
 *     same token that authenticated THIS deploy).
 *   - FABRIKA_IAM_PROVISIONING_KEY — fabrika's seeded IAM provisioning `px_` key, injected into deploys that reconcile
 *     schema. Omit at deploy to run without reconcile.
 *   - FABRIKA_RUNNER_KEY — shared with the runner Worker, which refuses any RPC without it (the service binding alone
 *     authenticates nobody).
 *   - OPERATIONS_SYNC_KEY — the private Control → Operations catalog bearer.
 *   - the installation mail provider's credentials (`FABRIKA_EMAIL_*`), when the installation has a valid transport.
 */
export const controlPipelineSecrets = (source: EnvironmentSource): string[] => [
	'FABRIKA_CONTROL_VAULT_KEY',
	'CLOUDFLARE_API_TOKEN',
	'FABRIKA_IAM_PROVISIONING_KEY',
	'FABRIKA_RUNNER_KEY',
	'OPERATIONS_SYNC_KEY',
	...controlEmailSecrets(source),
]

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
	const bootstrapAdmins = process.env['FABRIKA_CONTROL_BOOTSTRAP_ADMINS'] ?? '[]'
	const iamUrl = resolveIamUrl(isLocal)

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
			// Every request but a built file reaches the Worker first. Workers Assets would otherwise answer a browser
			// navigation itself, and its SPA fallback hands `index.html` to every server path a browser opens (the GitHub
			// manifest handoff, `/builder/connect`, `/healthz`). `controlApp` routes every path by `fabrika.service.ts`, and
			// its `console` row hands the rest to `ASSETS`, which applies the SPA fallback: the table decides, as on the Bun
			// process. Vite's hashed bundles under `/assets/` match no other row, so they skip the Worker.
			run_worker_first: ['/*', '!/assets/*'],
		},
		vars: {
			...controlEmailVars(isLocal),
			ENVIRONMENT: env,
			// The public domain this stage serves on (drives absolute URLs); empty when unknown.
			FABRIKA_CONTROL_DOMAIN: domain ?? '',
			// Bootstrap-admin fallback (src/iam.ts): a JSON array of emails authorized as admin even
			// when IAM denies / the binding isn't wired yet. Empty by default; the bootstrap
			// script (scripts/bootstrap.ts) sets the first operator's email here for initial bring-up.
			FABRIKA_CONTROL_BOOTSTRAP_ADMINS: bootstrapAdmins,
			// The selected Cloudflare provider's account id and IAM origin. The composition root
			// injects them into provider jobs without persisting credentials in the registry.
			CLOUDFLARE_ACCOUNT_ID: process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '',
			FABRIKA_IAM_ISSUER: iamUrl,
			...(operationsArtifactOrigin === undefined || operationsArtifactOrigin === ''
				? {}
				: { OPERATIONS_ARTIFACT_ORIGIN: operationsArtifactOrigin }),
		},
		bindings: {
			// Run logs + terminal status, keyed by run id (runs/<id>/logs.ndjson, runs/<id>/status.json).
			RUN_LOGS: new R2Bucket({ name: 'vozka-run-logs' }),
			// Registry + run history + the per-app-env deploy LOCKS: a `deploy_locks` row per `<app>:<env>`
			// serializes deploys of the same target (it replaced a Durable Object — see src/deploy-locks.ts),
			// so two triggers can't race on cf-state / wrangler / IAM. D1 is region-specific → pinned
			// to EU West. Migrations in ./migrations.
			DB: new D1Database({ name: 'vozka', migrationsDir: './migrations', locationHint: 'weur' }),
			// Deploy job queue: producer (POST /webhooks/github/:connectionId + triggerDeploy) + consumer (queue()).
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
			// The mail relay's dispatch queue (src/mail-relay): one relayed message per job, producer (acceptance, release,
			// maintenance) and consumer (queue()). The dispatcher settles or requeues its row on every send failure, so a
			// redelivery is only for an unexpected throw; maintenance re-enqueues a message whose job was lost.
			MAIL_QUEUE: new Queue({
				name: 'fabrika-mail',
				binding: 'both',
				consumer: { maxBatchSize: 1, maxRetries: 5, retryDelay: 60 },
			}),
			// The relay's message content, one object per message (src/db/mail-messages.ts): a D1 row holds at most
			// 2,000,000 bytes, and the relay accepts more. Only this Worker binds it; the runner never does.
			MAIL_CONTENT: new R2Bucket({ name: 'fabrika-mail-content' }),
			// IAM is bound in EVERY environment, local included: src/iam.ts verifies an IAM-issued token
			// and has no local mode to fall back on, and the proxy Worker in front of this one already
			// binds the same service unconditionally. Local dev therefore wants `packages/iam`'s
			// `bun run dev` running alongside, exactly as `examples/app` does.
			IAM: new ServiceReference('propustka-worker'),
			// Off-local only: Operations, and the runner Worker — the deploy executor the queue consumer hands
			// each run to (RUNNER_SVC.startRun). The runner is its OWN Worker so a deploy of fabrika
			// never resets the container running it — deployed out-of-band (packages/runner-cloudflare bootstrap).
			...(isLocal ? {} : {
				OPERATIONS: new ServiceReference('operations'),
				RUNNER_SVC: new ServiceReference('vozka-runner'),
			}),
		},
	})
}

export const buildControlWorker = (ctx: ResourceContext): Worker => {
	const iamUrl = resolveIamUrl(ctx.env === 'local')
	return createCloudflareProxyWorker({
		name: 'vozka-proxy',
		app: buildControlApplicationWorker(ctx),
		appId: CONTROL_APP_ID,
		appHost: ctx.domain ?? 'localhost',
		// A Worker serves no MCP: the console's table without its `oauth` row.
		installation: serviceProxyTable(controlServiceContract({ mcp: false }), { oauth: false }),
		domain: ctx.domain,
		iamUrl,
	})
}

export default defineApp({
	id: CONTROL_APP_ID,
	resources: buildControlWorker,
	schema: controlSchema,
	pipeline: {
		// fabrika's Worker source lives alongside this config (packages/control).
		workerDir: '.',
		// Build the dashboard SPA into ../dashboard/dist (the ASSETS directory) before deploy.
		build: 'bun run --filter @fabrika/dashboard build',
		secrets: controlPipelineSecrets(process.env),
	},
})
