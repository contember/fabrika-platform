/**
 * `fabrika platform init --provider=cloudflare <account>` — bring up a CF account's fabrika control-plane base from (ideally) just a
 * Cloudflare API token. Idempotent + resumable (every captured value lands in `.env`, which Bun
 * auto-loads on the next run). The REAL deploy runs in GitHub Actions (the scaffolded pipeline calls
 * `fabrika platform deploy`), so this laptop never needs the CF toolchain or docker.
 *
 * Order: CF token → account + zones → smart-default prompts → vault key → provisioning key → GitHub App
 * (manifest) → scaffold the base repo → write the GitHub Environment → trigger. Secret VALUES flow only
 * into `.env`, `gh` over stdin, and child env — never through `log.ts`.
 */

import { environmentAliases } from '@fabrika/platform'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { findZone, listZones, resolveAccountId, verifyToken } from './cloudflare'
import { fromEnv, persistEnv } from './envfile'
import { configureEnvironment, triggerPlatformWorkflow } from './environment'
import { createAppViaManifest, type CreatedGitHubApp, promptInstall } from './github-app'
import { action, detail, info, ok, step, url, warn } from './log'
import { confirm, retry, secret, secretOrEnv, text } from './prompt'
import { defaultCheckoutDir, readFabrikaRef, scaffoldPlatformRepo } from './scaffold'

/** Everything collected before the scaffold + environment write. */
interface Collected {
	account: string
	accountId: string
	apiToken: string
	controlPlaneDomain: string
	operationsHostname: string
	githubOrg: string
	platformRepo: string
	iamUrl: string
	/** IAM's admin hostname (the host of `iamUrl`) — its Custom Domain + token `iss`. */
	iamHostname: string
	/** OIDC provider issuer IAM federates human login to (discovery URL base). */
	oidcIssuer: string
	/** OIDC client id (public). The placeholder constant when the operator deferred real SSO. */
	oidcClientId: string
	/** Email domains admitted as a human at IAM login (self-provisioning allowlist). */
	humanEmailDomains: string[]
	bootstrapAdmins: string[]
	installRepos: string[]
}

/**
 * Placeholder OIDC — written when the operator brings the base up BEFORE wiring a real SSO provider.
 * IAM boots + machine auth (provisioning key) + the bootstrap-admin hatch all work; only human SSO
 * login is inert until real `FABRIKA_IAM_OIDC_CLIENT_ID`/`_SECRET` replace these. Issuer stays a real
 * discoverable host so IAM's OIDC discovery doesn't fail at boot.
 */
const PLACEHOLDER_OIDC_CLIENT_ID = 'placeholder.apps.googleusercontent.com'
const PLACEHOLDER_OIDC_CLIENT_SECRET = 'placeholder-oidc-client-secret-rotate-when-sso-wired'
const ENVIRONMENT_SOURCE: Readonly<Record<string, string | undefined>> = process.env

/** Resume reads apply canonical precedence first, then keep fromEnv's empty-string semantics. */
export function readResumeEnvironmentAlias(
	source: Readonly<Record<string, string | undefined>>,
	canonical: string,
	legacy: string,
): string | undefined {
	const canonicalValue = source[canonical]
	const legacyValue = source[legacy]
	const value = environmentAliases.read(
		{
			[canonical]: canonicalValue,
			[legacy]: legacyValue === undefined || legacyValue === '' ? undefined : legacyValue,
		},
		{ canonical, legacy },
	)
	return value === '' ? undefined : value
}

/** Run the full bring-up for `<account>`. */
export async function runInit(account: string): Promise<void> {
	console.log(`\nfabrika platform init — bring up the ${account} Cloudflare control-plane base\n`)

	const collected = await collect(account)
	const vaultKey = await ensureVaultKey()
	const provisioning = await ensureProvisioningKey()
	const operationsSyncKey = await ensureOperationsSyncKey()
	const signingKeys = await ensureSigningKeys()
	const oidcClientSecret = await ensureOidcClientSecret(collected.oidcClientId === PLACEHOLDER_OIDC_CLIENT_ID)
	const app = await ensureGitHubApp(collected)

	const { dir } = await scaffoldPlatformRepo({
		repo: collected.platformRepo,
		account: collected.account,
		dir: defaultCheckoutDir(collected.account),
	})

	// GitHub RESERVES the `GITHUB_` prefix for secret + variable names in an Environment (the API rejects
	// them, 422), so the App's key/secret/id ride under a `GH_` prefix here. platform.yml maps each back to
	// the `GITHUB_*` env var the deploy + Worker bindings expect — that rename is GitHub-side only.
	await configureEnvironment({
		repo: collected.platformRepo,
		environment: collected.account,
		secrets: {
			CLOUDFLARE_ACCOUNT_ID: collected.accountId,
			CLOUDFLARE_API_TOKEN: collected.apiToken,
			FABRIKA_CONTROL_VAULT_KEY: vaultKey,
			GH_APP_PRIVATE_KEY: app.pem,
			GH_WEBHOOK_SECRET: app.webhookSecret,
			FABRIKA_IAM_PROVISIONING_KEY: provisioning,
			OPERATIONS_SYNC_KEY: operationsSyncKey,
			// IAM Stage 1 native-auth secrets (pushed as IAM Worker secrets by the pipeline).
			FABRIKA_IAM_SIGNING_KEYS: signingKeys,
			FABRIKA_IAM_OIDC_CLIENT_SECRET: oidcClientSecret,
		},
		vars: {
			FABRIKA_CONTROL_DOMAIN: collected.controlPlaneDomain,
			OPERATIONS_HOSTNAME: collected.operationsHostname,
			GH_APP_ID: String(app.id),
			FABRIKA_IAM_URL: collected.iamUrl,
			FABRIKA_CONTROL_BOOTSTRAP_ADMINS: JSON.stringify(collected.bootstrapAdmins),
			// IAM Stage 1 non-secret config (read by IAM's fabrika config).
			FABRIKA_IAM_HOSTNAME: collected.iamHostname,
			FABRIKA_IAM_OIDC_ISSUER: collected.oidcIssuer,
			FABRIKA_IAM_OIDC_CLIENT_ID: collected.oidcClientId,
			FABRIKA_IAM_HUMAN_EMAIL_DOMAINS: JSON.stringify(collected.humanEmailDomains),
			// The same first-admin emails admit the operator to IAM itself (its own bootstrap hatch).
			FABRIKA_IAM_BOOTSTRAP_ADMINS: JSON.stringify(collected.bootstrapAdmins),
		},
	})

	await triggerDeploy(collected.platformRepo)
	finalNotes(collected.platformRepo, collected.account, dir, await readFabrikaRef(dir))
}

/** Collect the CF token + account, then the smart-default prompts. */
async function collect(account: string): Promise<Collected> {
	step('Cloudflare API token')
	info("Only hard input. It authenticates the deploy AND becomes the control plane's runtime CLOUDFLARE_API_TOKEN secret.")
	const verified = await retry('Cloudflare API token', async () => {
		const apiToken = await secretOrEnv('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN')
		detail(`Resolving the Cloudflare account for this token (${apiToken.length} chars)…`)
		const cfAccount = await resolveAccountId(apiToken)
		if (await verifyToken(apiToken, cfAccount.id)) {
			ok('Token verified (status active).')
		} else {
			warn('Could not pre-verify the token via the Cloudflare API.')
			detail('Expected for some account-owned tokens (invisible to /user/tokens/verify); the deploy validates it for real.')
			if (!(await confirm('Proceed anyway?', true))) {
				throw new Error('Token not verified — re-enter it.')
			}
		}
		return { apiToken, cfAccount }
	})
	const { apiToken, cfAccount } = verified
	ok(`Account: ${cfAccount.name} (${cfAccount.id})`)
	await persistEnv('CLOUDFLARE_API_TOKEN', apiToken)
	await persistEnv('CLOUDFLARE_ACCOUNT_ID', cfAccount.id)

	step('Account details (Enter accepts the default)')
	const zones = await listZones(apiToken, cfAccount.id)
	const primaryZone = zones[0]?.name
	const controlPlaneDomain = await text('fabrika control-plane domain', primaryZone !== undefined ? `fabrika.${primaryZone}` : undefined)
	if (controlPlaneDomain === '') {
		throw new Error('A fabrika control-plane domain is required.')
	}
	const zone = await findZone(apiToken, controlPlaneDomain).catch(() => null)
	if (zone === null) {
		warn(`No Cloudflare zone found for ${controlPlaneDomain} — a custom-domain bind would fail. Add the zone before the deploy.`)
	} else {
		ok(`Zone found: ${zone.name}`)
	}
	const operationsHostname = await text('Operations ingest domain', primaryZone !== undefined ? `errors.${primaryZone}` : undefined)
	if (operationsHostname === '') {
		throw new Error('An Operations ingest domain is required.')
	}
	const operationsZone = await findZone(apiToken, operationsHostname).catch(() => null)
	if (operationsZone === null) {
		warn(`No Cloudflare zone found for ${operationsHostname} — the Operations custom-domain bind would fail.`)
	} else {
		ok(`Zone found: ${operationsZone.name}`)
	}
	const githubOrg = await text('GitHub org that owns the fabrika App + platform repo', account)
	const platformRepo = await text('Platform repo (org/fabrika-platform)', `${githubOrg}/fabrika-platform`)
	const iamUrl = await retry('IAM base URL', async () => {
		const raw = (await text('IAM base URL', primaryZone !== undefined ? `https://iam.${primaryZone}` : undefined)).replace(/\/+$/, '')
		if (!URL.canParse(raw)) {
			throw new Error(`Not a valid URL: ${raw === '' ? '(empty)' : raw}`)
		}
		return raw
	})
	const adminsRaw = await text('First-admin email(s) for the escape hatch (comma-separated)')
	const bootstrapAdmins = adminsRaw.split(',').map((s) => s.trim()).filter(Boolean)
	const reposRaw = await text('App repos to install the GitHub App on (comma-separated, e.g. contember/poplach)', '')
	const installRepos = reposRaw.split(',').map((s) => s.trim()).filter(Boolean)

	// IAM Stage 1 config: its admin hostname (= the IAM URL's host, its Custom Domain + token
	// `iss`), the OIDC upstream it federates human login to, and the email-domain allowlist. The OIDC client
	// id may be left blank to bring the base up with PLACEHOLDER OIDC — IAM boots and machine auth +
	// the bootstrap-admin hatch work immediately; only human SSO login waits for a real provider.
	step('IAM auth config (Stage 1)')
	const iamHostname = new URL(iamUrl).host
	ok(`IAM hostname (from URL): ${iamHostname}`)
	const oidcIssuer = await text('IAM OIDC issuer URL', 'https://accounts.google.com')
	const oidcClientIdRaw = await text('IAM OIDC client id (blank = placeholder OIDC for now)', '')
	if (oidcClientIdRaw === '') {
		warn('Placeholder OIDC — human SSO login is inert until you set real FABRIKA_IAM_OIDC_CLIENT_ID + _SECRET.')
	}
	const oidcClientId = oidcClientIdRaw === '' ? PLACEHOLDER_OIDC_CLIENT_ID : oidcClientIdRaw
	const humanRaw = await text('IAM human email domains, comma-separated (who may self-provision at login)', '')
	const humanEmailDomains = humanRaw.split(',').map((s) => s.trim()).filter(Boolean)

	return {
		account,
		accountId: cfAccount.id,
		apiToken,
		controlPlaneDomain,
		operationsHostname,
		githubOrg,
		platformRepo,
		iamUrl,
		iamHostname,
		oidcIssuer,
		oidcClientId,
		humanEmailDomains,
		bootstrapAdmins,
		installRepos,
	}
}

/**
 * Generate the M4 vault KEK: 32 random bytes, base64. It lives nowhere else (never in D1 or logs), so
 * losing it is unrecoverable. Persist it locally and tell the operator where to secure it.
 */
interface VaultKeyDependencies {
	readonly source: Readonly<Record<string, string | undefined>>
	persist(name: string, value: string): Promise<void>
	generate(): string
	created(message: string, details: string[]): void
}

const vaultKeyDependencies: VaultKeyDependencies = {
	source: ENVIRONMENT_SOURCE,
	persist: persistEnv,
	generate: () => randomBytes(32).toString('base64'),
	created: action,
}

export async function ensureVaultKey(dependencies: VaultKeyDependencies = vaultKeyDependencies): Promise<string> {
	step('Generate the vault master key (FABRIKA_CONTROL_VAULT_KEY)')
	const existing = readResumeEnvironmentAlias(dependencies.source, 'FABRIKA_CONTROL_VAULT_KEY', 'VOZKA_VAULT_KEY')
	if (existing !== undefined) {
		await dependencies.persist('FABRIKA_CONTROL_VAULT_KEY', existing)
		ok('Reusing FABRIKA_CONTROL_VAULT_KEY from .env (resume).')
		return existing
	}
	const key = dependencies.generate()
	await dependencies.persist('FABRIKA_CONTROL_VAULT_KEY', key)
	dependencies.created('SAVED to .env (gitignored) — copy that file to your password manager; the vault KEK is unrecoverable if lost', [
		"It is the master key for fabrika's encrypted secret vault.",
		'The value is intentionally not printed.',
	])
	return key
}

/**
 * Generate the operator-side provisioning key (the "seeded key"): a single opaque `px_` bearer, stored
 * once. IAM Stage 1 SEEDS it (the `FABRIKA_IAM_PROVISIONING_KEY` secret — `resolveCaller` admits a
 * bearer matching it as a synthetic admin) and fabrika Stage 2 USES it to authenticate schema reconciles.
 * Shaped like an IAM-native key (`px_` + 160 bits base64url). An operator who already has one can
 * pre-set `FABRIKA_IAM_PROVISIONING_KEY` in env; the deprecated name remains a resume fallback.
 */
async function ensureProvisioningKey(): Promise<string> {
	step('Provisioning key (FABRIKA_IAM_PROVISIONING_KEY)')
	const existing = readResumeEnvironmentAlias(ENVIRONMENT_SOURCE, 'FABRIKA_IAM_PROVISIONING_KEY', 'PROPUSTKA_PROVISIONING_KEY')
	if (existing !== undefined) {
		await persistEnv('FABRIKA_IAM_PROVISIONING_KEY', existing)
		ok('Reusing the provisioning key from .env (resume).')
		return existing
	}
	const key = `px_${randomBytes(20).toString('base64url')}`
	await persistEnv('FABRIKA_IAM_PROVISIONING_KEY', key)
	ok('Provisioning key generated + saved to .env.')
	detail('IAM Stage 1 seeds this as an admin credential; the control plane reconciles with it in Stage 2.')
	return key
}

async function ensureOperationsSyncKey(): Promise<string> {
	step('Operations catalog key (OPERATIONS_SYNC_KEY)')
	const existing = fromEnv('OPERATIONS_SYNC_KEY')
	if (existing !== undefined) {
		if (existing.length < 32) throw new Error('OPERATIONS_SYNC_KEY must be at least 32 characters.')
		ok('Reusing OPERATIONS_SYNC_KEY from .env (resume).')
		return existing
	}
	const key = randomBytes(32).toString('base64url')
	await persistEnv('OPERATIONS_SYNC_KEY', key)
	ok('Operations catalog key generated + saved to .env.')
	return key
}

/** One ES256 (EC P-256) private JWK with an RFC 7638 thumbprint `kid`, shaped exactly as IAM's
 * `Signer.fromPrivateJwks` loads it (index 0 = the active signer). */
function generateEs256Jwk(): JsonWebKey & { kid: string } {
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
	const jwk = privateKey.export({ format: 'jwk' })
	// RFC 7638 thumbprint over the canonical EC members, lexicographic order (crv, kty, x, y).
	const thumbprint = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url')
	return { ...jwk, kid: thumbprint, alg: 'ES256', use: 'sig' }
}

/**
 * Generate IAM's token-signing key (Stage 1): a JSON array with one ES256 private JWK. IAM
 * signs every token it issues with index 0 and publishes the public half in its JWKS. Stored once
 * (`FABRIKA_IAM_SIGNING_KEYS`) and pushed as an IAM Worker secret by Stage 1. Resume-safe; it must be
 * DURABLE — rotating it invalidates every live token (so we never regenerate when one already exists).
 */
async function ensureSigningKeys(): Promise<string> {
	step('Generate the IAM signing key (FABRIKA_IAM_SIGNING_KEYS)')
	const existing = readResumeEnvironmentAlias(ENVIRONMENT_SOURCE, 'FABRIKA_IAM_SIGNING_KEYS', 'PROPUSTKA_SIGNING_KEYS')
	if (existing !== undefined) {
		await persistEnv('FABRIKA_IAM_SIGNING_KEYS', existing)
		ok('Reusing FABRIKA_IAM_SIGNING_KEYS from .env (resume).')
		return existing
	}
	const keys = JSON.stringify([generateEs256Jwk()])
	await persistEnv('FABRIKA_IAM_SIGNING_KEYS', keys)
	ok('IAM signing key generated (1 × ES256) + saved to .env.')
	return keys
}

/**
 * Resolve IAM's OIDC client secret (Stage 1). Reused from `.env` on resume; otherwise a hidden
 * prompt for a real provider, or the placeholder when SSO was deferred (blank client id). Always persisted
 * so a re-run reuses it. NEVER logged.
 */
async function ensureOidcClientSecret(placeholder: boolean): Promise<string> {
	step('IAM OIDC client secret (FABRIKA_IAM_OIDC_CLIENT_SECRET)')
	const existing = readResumeEnvironmentAlias(ENVIRONMENT_SOURCE, 'FABRIKA_IAM_OIDC_CLIENT_SECRET', 'PROPUSTKA_OIDC_CLIENT_SECRET')
	if (existing !== undefined) {
		await persistEnv('FABRIKA_IAM_OIDC_CLIENT_SECRET', existing)
		ok('Reusing FABRIKA_IAM_OIDC_CLIENT_SECRET from .env (resume).')
		return existing
	}
	const value = placeholder ? PLACEHOLDER_OIDC_CLIENT_SECRET : await secret('IAM OIDC client secret')
	await persistEnv('FABRIKA_IAM_OIDC_CLIENT_SECRET', value)
	ok(placeholder ? 'Placeholder OIDC client secret saved to .env.' : 'OIDC client secret saved to .env.')
	return value
}

/** Create the GitHub App via the manifest flow (or reuse from .env), then prompt to install it. */
async function ensureGitHubApp(collected: Collected): Promise<CreatedGitHubApp> {
	step('Create the fabrika GitHub App (manifest flow)')
	const pem = fromEnv('GITHUB_APP_PRIVATE_KEY')
	const webhookSecret = fromEnv('GITHUB_WEBHOOK_SECRET')
	if (pem !== undefined && webhookSecret !== undefined) {
		const slug = fromEnv('GITHUB_APP_SLUG') ?? 'fabrika'
		ok('Reusing the GitHub App from .env (resume) — skipping manifest creation.')
		const app: CreatedGitHubApp = {
			id: Number(fromEnv('GITHUB_APP_ID') ?? '0'),
			slug,
			htmlUrl: fromEnv('GITHUB_APP_URL') ?? `https://github.com/apps/${slug}`,
			pem,
			webhookSecret,
		}
		detail(`Install (if needed): ${url(`https://github.com/apps/${app.slug}/installations/new`)}`)
		return app
	}
	const appName = await text('GitHub App name', `fabrika-${collected.account}`)
	// PUBLIC iff installed across orgs: GitHub only lets a private App install on its OWNER's repos, so an
	// App owned by this account's org but deploying repos in another org (e.g. manGoweb-owned, deploying
	// contember/poplach) must be public. Same-org installs stay private.
	const ownerOrg = collected.githubOrg.toLowerCase()
	const isPublic = collected.installRepos.some((repo) => (repo.split('/')[0] ?? '').toLowerCase() !== ownerOrg)
	const app = await createAppViaManifest({
		org: collected.githubOrg,
		appName,
		controlPlaneDomain: collected.controlPlaneDomain,
		public: isPublic,
	})
	await persistEnv('GITHUB_APP_PRIVATE_KEY', app.pem)
	await persistEnv('GITHUB_WEBHOOK_SECRET', app.webhookSecret)
	await persistEnv('GITHUB_APP_ID', String(app.id))
	await persistEnv('GITHUB_APP_SLUG', app.slug)
	await persistEnv('GITHUB_APP_URL', app.htmlUrl)
	ok('GitHub App credentials saved to .env (resume-safe).')
	if (collected.installRepos.length > 0) {
		await promptInstall(app, collected.installRepos)
	} else {
		detail(`Install the App on the repos fabrika will deploy when you onboard them: ${url(`https://github.com/apps/${app.slug}/installations/new`)}`)
	}
	return app
}

/** Trigger the platform workflow (first bring-up builds the runner image into this account's registry). */
async function triggerDeploy(repo: string): Promise<void> {
	step('Trigger the platform deploy (GitHub Actions)')
	info('GitHub Actions runs the real deploy — fabrika runner then control plane. The first run builds the runner')
	info('container image into this account (CI has docker); this laptop deploys nothing.')
	const go = await confirm(`Run the platform workflow on ${repo} now (build_runner_image=true)?`, true)
	if (!go) {
		action('OPERATOR ACTION — run it when ready', [
			`gh workflow run platform.yml --repo ${repo} -f build_runner_image=true`,
			`or: ${url(`https://github.com/${repo}/actions`)} → platform → Run workflow`,
		])
		return
	}
	await triggerPlatformWorkflow(repo, true)
	ok('Platform workflow triggered.')
	detail(`Watch: ${url(`https://github.com/${repo}/actions`)}   (or: gh run watch --repo ${repo})`)
}

/** Closing notes: the local checkout, the escape hatch, and what runs in CI. */
function finalNotes(repo: string, account: string, dir: string, ref: string): void {
	step('Done')
	ok(`Base repo: ${repo} (pinned fabrika ref: ${ref})`)
	ok(`Local checkout + .env: ${dir}`)
	info('The fabrika control plane came up with the bootstrap-admin escape hatch OPEN (FABRIKA_CONTROL_BOOTSTRAP_ADMINS set).')
	action('OPERATOR ACTION — close the hatch after IAM grants you the fabrika admin role', [
		`1. gh variable set FABRIKA_CONTROL_BOOTSTRAP_ADMINS --repo ${repo} --env ${account} --body '[]'`,
		`2. gh workflow run platform.yml --repo ${repo}`,
		'3. Authorization is then fully IAM-owned.',
	])
}
