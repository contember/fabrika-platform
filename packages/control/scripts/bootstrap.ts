#!/usr/bin/env bun
/**
 * Self-deploy FABRIKA through its Cloudflare provider, using `fabrika.config.ts`. Run it FROM A LAPTOP
 * for the first bring-up AND as a break-glass redeploy/recovery when the live control plane can't
 * self-deploy (bad self-deploy, wedged D1, a stuck `deploy_locks` row) — it does NOT depend on a running fabrika.
 *
 * IDEMPOTENT — safe to re-run. The provider is declarative (oblaka provision, D1 migrations apply only the
 * new ones, `wrangler deploy` / `secret put` overwrite, IAM reconcile is an idempotent PUT), so a
 * re-run converges. The ONLY stateful knob is the escape hatch: `FABRIKA_CONTROL_BOOTSTRAP_ADMINS` makes the FIRST
 * operator an admin before IAM has any grant for them, breaking
 * the chicken-and-egg of "you need to be authorized to authorize yourself". It is OPTIONAL, defaulting to
 * '[]' (hatch CLOSED) so a routine redeploy doesn't reopen it — see the warning in main().
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * ORDERING for a real bring-up on a fresh account (each step is a SEPARATE operator action):
 *
 *   1. IAM FIRST. fabrika authenticates + authorizes through IAM, so IAM's admin front door must exist
 *      before fabrika can reconcile its own schema into it. Deploy IAM, then provide its seeded
 *      provisioning key through `FABRIKA_IAM_PROVISIONING_KEY`.
 *
 *   2. fabrika SECOND — THIS script. Deploys fabrika via the engine with FABRIKA_CONTROL_BOOTSTRAP_ADMINS set to the
 *      first operator's email(s). After it lands, that operator can sign in through Access and use the
 *      whole control plane as admin even though IAM has granted them nothing yet. Re-runnable: a
 *      later `bun run bootstrap` with NO admins is a safe break-glass redeploy of the live control plane.
 *
 *   3. REGISTER apps THIRD — `scripts/seed.ts` (apps registry rows) so a GitHub push self-deploys
 *      them. Run it against the now-live control plane. (fabrika is single-account — there is no
 *      account registry; the CF account/token are fabrika's own Worker config, set in step 2.)
 *
 *   4. Once the operator has set up real IAM grants, REMOVE FABRIKA_CONTROL_BOOTSTRAP_ADMINS (set it
 *      back to `[]` and redeploy) so the escape hatch is closed and authorization is fully IAM-owned.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * This script orchestrates ONLY step 2 (fabrika's own deploy). Steps 1, 3, 4 are operator actions,
 * documented above (3 is scripts/seed.ts).
 *
 * Required env (NEVER committed/logged — the operator holds these):
 *   CLOUDFLARE_ACCOUNT_ID                          — the SINGLE CF account fabrika runs on + deploys into.
 *   CLOUDFLARE_API_TOKEN                           — the account-wide CF token. Authenticates THIS deploy
 *                                                    AND becomes fabrika's runtime secret (it deploys every
 *                                                    other app with the same token — single-account).
 *   FABRIKA_IAM_URL, FABRIKA_IAM_PROVISIONING_KEY — IAM's base URL + fabrika's seeded provisioning
 *                                                    `px_` key. Become fabrika's runtime config.
 *   FABRIKA_CONTROL_DOMAIN                         — fabrika's hostname.
 *   FABRIKA_CONTROL_VAULT_KEY                      — the M4 vault master key (32 raw bytes, base64).
 *   GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET  — the GitHub App PEM key + webhook HMAC secret.
 * Optional:
 *   FABRIKA_CONTROL_BOOTSTRAP_ADMINS               — JSON array of the first operator email(s). Set ONLY for
 *                                                    the FIRST bring-up (or recovery); omit on a routine
 *                                                    redeploy to keep the escape hatch CLOSED. Default '[]'.
 *   FABRIKA_CONTROL_ENV (default `prod`).
 *
 * Usage:
 *   FABRIKA_CONTROL_BOOTSTRAP_ADMINS='["you@org.com"]' bun run scripts/bootstrap.ts   # FIRST bring-up (hatch OPEN)
 *   bun run scripts/bootstrap.ts                                            # break-glass redeploy (hatch CLOSED)
 *   bun run scripts/bootstrap.ts --dry-run                                  # plan-only — graph + every step, no CF
 */

import { deployCloudflareConfig } from '@fabrika/provider-cloudflare'
import { resolve } from 'node:path'

const DRY_RUN = process.argv.includes('--dry-run')

/** Read a required env var, or fail loudly (never proceed with a half-set deploy). */
function required(name: string): string {
	const value = process.env[name]
	if (value === undefined || value === '') {
		throw new Error(`Missing required env var ${name} (see this script's header for the full list).`)
	}
	return value
}

/** Optional env var (undefined when unset). */
function optional(name: string): string | undefined {
	const value = process.env[name]
	return value === undefined || value === '' ? undefined : value
}

async function main(): Promise<void> {
	required('FABRIKA_CONTROL_DOMAIN')
	// FABRIKA_CONTROL_BOOTSTRAP_ADMINS is OPTIONAL so this script is idempotent — re-runnable as a break-glass
	// self-deploy of an already-live fabrika WITHOUT reopening the escape hatch. Unset/empty → '[]' (hatch
	// CLOSED), matching fabrika.config's own default (fabrika.config.ts). On a FIRST bring-up you MUST set it,
	// else nobody — not even you — can authorize and you lock yourself out (the warning in main() is loud).
	const bootstrapAdmins = optional('FABRIKA_CONTROL_BOOTSTRAP_ADMINS') ?? '[]'
	process.env['FABRIKA_CONTROL_BOOTSTRAP_ADMINS'] = bootstrapAdmins

	const env = optional('FABRIKA_CONTROL_ENV') ?? 'prod'

	// The secret VALUES fabrika needs at deploy, gathered by the SAME names the config declares in
	// `pipeline.secrets`. Read from the environment; never inlined, never logged. CLOUDFLARE_API_TOKEN +
	// the IAM provisioning key are fabrika's RUNTIME platform creds (it injects them into every
	// deploy it runs), so they are required Worker secrets — a fabrika without them can't deploy/reconcile.
	for (
		const name of [
			'CLOUDFLARE_ACCOUNT_ID',
			'CLOUDFLARE_API_TOKEN',
			'GITHUB_APP_PRIVATE_KEY',
			'GITHUB_WEBHOOK_SECRET',
		]
	) {
		required(name)
	}
	required('FABRIKA_IAM_URL')
	required('FABRIKA_IAM_PROVISIONING_KEY')
	required('FABRIKA_CONTROL_VAULT_KEY')

	// The bootstrap admin list is set on the deploy's environment (the engine's `wrangler secret put` /
	// var path picks up fabrika.config's `FABRIKA_CONTROL_BOOTSTRAP_ADMINS` var. We log
	// only the COUNT — never the emails or any secret value.
	const adminCount = (() => {
		try {
			const parsed: unknown = JSON.parse(bootstrapAdmins)
			return Array.isArray(parsed) ? parsed.length : 0
		} catch {
			return 0
		}
	})()
	console.log(`Deploying vozka → ${env}${DRY_RUN ? ' (dry-run)' : ''} (idempotent — safe to re-run).`)
	if (adminCount > 0) {
		// Escape hatch OPEN: these operators are admin even before IAM grants them anything. Correct
		// for a FIRST bring-up (or recovery); on a routine redeploy it needlessly reopens the hatch.
		console.log(`  Escape hatch OPEN — ${adminCount} bootstrap admin(s) via FABRIKA_CONTROL_BOOTSTRAP_ADMINS.`)
	} else {
		// Escape hatch CLOSED: the SAFE state for redeploying an already-live fabrika (authorization stays
		// fully IAM-owned). But a FIRST bring-up with 0 admins locks the operator out — warn loudly.
		console.warn('  ⚠ No bootstrap admins (escape hatch CLOSED) — safe for a REDEPLOY of a live vozka.')
		console.warn('    If this is the FIRST bring-up, abort now and set FABRIKA_CONTROL_BOOTSTRAP_ADMINS, or you will lock yourself out.')
	}

	// oblaka's programmatic deploy reads the existing wrangler.jsonc relative to process.cwd() but
	// writes it relative to the provider cwd. When launched from the repo root the read otherwise misses
	// the committed config and oblaka fresh-gens the DO migrations (losing history → tag-shift → wrangler
	// 10074 when a DO class is removed). chdir into the worker dir so read + write agree and the committed
	// migration history is preserved. (The runner path already runs with cwd = the worker dir.)
	const cwd = resolve(import.meta.dir, '..')
	process.chdir(cwd)
	const result = await deployCloudflareConfig({
		env,
		configPath: resolve(cwd, 'fabrika.config.ts'),
		cwd,
		dryRun: DRY_RUN,
	})

	console.log(`\n${result.appId} → ${result.env}: ${result.status}`)
	for (const step of result.steps) {
		console.log(`  ${step.status.padEnd(10)} ${step.spec.id}${step.error !== undefined ? ` — ${step.error}` : ''}`)
	}
	if (result.status === 'failed') {
		process.exit(1)
	}

	if (adminCount > 0) {
		// First bring-up / recovery just ran with the hatch open — tell the operator how to close it.
		console.log('\nNext: register apps (scripts/seed.ts), then close the escape hatch — re-run')
		console.log('`bun run bootstrap` WITHOUT FABRIKA_CONTROL_BOOTSTRAP_ADMINS once IAM grants the operator admin.')
	}
}

main().catch((error: unknown) => {
	console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
