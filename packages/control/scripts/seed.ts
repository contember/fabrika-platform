#!/usr/bin/env bun
/**
 * Seed the control-plane registry with the durable `vozka` and `propustka` app IDs that let a GitHub push
 * self-deploy them. Runs AFTER fabrika is live (scripts/bootstrap.ts) — it talks to fabrika's own `/api/*`
 * HTTP surface, so it goes through the real ACL + audit path (it does NOT write D1 directly). The
 * bootstrap admin (or an IAM-granted admin) is the caller.
 *
 * fabrika is SINGLE-ACCOUNT: there is no account registry to seed. The CF account/token + IAM
 * coords are fabrika's OWN Worker config, set at bootstrap (scripts/bootstrap.ts), and injected into
 * every deploy. So this script only registers the apps.
 *
 * Idempotent: a row that already exists (HTTP 409) is treated as success, so re-running is safe.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * This needs REAL values at run time — DO NOT run it against a real control plane from here without
 * them. Everything is parameterized via env; the app SET is declared below (the fabrika + propustka
 * apps), but the repo URLs and domains are all env-driven so nothing real is hardcoded.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Required env:
 *   FABRIKA_CONTROL_API_URL                         — base URL of the live control plane.
 *   FABRIKA_CONTROL_REPO_URL, FABRIKA_IAM_REPO_URL — the GitHub repo URLs.
 *   FABRIKA_CONTROL_APP_DOMAIN, FABRIKA_IAM_APP_DOMAIN — per-app domains for their first env.
 * Optional:
 *   SEED_ENV                              — the env to register each app under (default `prod`).
 *   SEED_CONFIG_PATH                      — optional shared config path fallback.
 *   FABRIKA_CONTROL_CONFIG_PATH, FABRIKA_IAM_CONFIG_PATH — per-app config path overrides.
 *   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET — Access service-token creds for the API calls.
 *
 * Usage:
 *   bun run scripts/seed.ts             # POST the app rows to FABRIKA_CONTROL_API_URL
 *   bun run scripts/seed.ts --dry-run   # print the intended POSTs (app/env), call nothing
 */

const DRY_RUN = process.argv.includes('--dry-run')

function optional(name: string, fallback: string): string {
	const value = process.env[name]
	return value === undefined || value === '' ? fallback : value
}

function required(name: string): string {
	const value = process.env[name]
	if (value === undefined || value === '') {
		throw new Error(`Missing required env var ${name} (see this script's header for the full list).`)
	}
	return value
}

/** The Access service-token headers (when configured) so the API calls pass the front door as a machine. */
function authHeaders(): Record<string, string> {
	const id = process.env['CF_ACCESS_CLIENT_ID']
	const secret = process.env['CF_ACCESS_CLIENT_SECRET']
	if (id === undefined || id === '' || secret === undefined || secret === '') {
		return {}
	}
	return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }
}

interface SeedApp {
	id: string
	repoUrl: string
	env: string
	domain: string
	configPath: string
}

/** POST a JSON body to a control-plane route; 409 (already exists) reads as success (idempotent). */
async function post(base: string, path: string, body: unknown): Promise<void> {
	if (DRY_RUN) {
		console.log(`  [dry-run] POST ${path} ${JSON.stringify(body)}`)
		return
	}
	const response = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...authHeaders() },
		body: JSON.stringify(body),
	})
	if (response.status === 409) {
		console.log(`  = ${path} already exists (409) — skipped`)
		return
	}
	if (!response.ok) {
		throw new Error(`POST ${path} → ${response.status}: ${(await response.text()).slice(0, 500)}`)
	}
	console.log(`  ✓ ${path} → ${response.status}`)
}

async function main(): Promise<void> {
	const base = required('FABRIKA_CONTROL_API_URL').replace(/\/$/, '')
	const seedEnv = optional('SEED_ENV', 'prod')
	const sharedConfigPath = process.env['SEED_CONFIG_PATH']

	// The known apps. fabrika registers ITSELF (self-deploy on push); propustka is registered too so
	// fabrika can deploy it. Repo URLs + domains are env-driven. The deploy target account is fabrika's own.
	const apps: SeedApp[] = [
		{
			id: 'vozka',
			repoUrl: required('FABRIKA_CONTROL_REPO_URL'),
			env: seedEnv,
			domain: required('FABRIKA_CONTROL_APP_DOMAIN'),
			configPath: optional('FABRIKA_CONTROL_CONFIG_PATH', sharedConfigPath ?? 'packages/control/fabrika.config.ts'),
		},
		{
			id: 'propustka',
			repoUrl: required('FABRIKA_IAM_REPO_URL'),
			env: seedEnv,
			domain: required('FABRIKA_IAM_APP_DOMAIN'),
			configPath: optional('FABRIKA_IAM_CONFIG_PATH', sharedConfigPath ?? 'packages/iam/fabrika.config.ts'),
		},
	]

	console.log(`Seeding registry at ${base}${DRY_RUN ? ' (dry-run)' : ''}\n`)

	console.log('Apps (+ first env via onboarding):')
	for (const app of apps) {
		await post(base, '/api/register-app', {
			id: app.id,
			repoUrl: app.repoUrl,
			env: app.env,
			domain: app.domain,
			target: { provider: 'cloudflare', version: 1, payload: {} },
			artifact: { provider: 'cloudflare', version: 1, payload: { configPath: app.configPath } },
		})
	}

	console.log('\nDone. Pushes to the registered repos now self-deploy through vozka.')
}

main().catch((error: unknown) => {
	console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
