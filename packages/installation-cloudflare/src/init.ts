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

import {
	action,
	configureEnvironment,
	confirm,
	type CreatedGitHubApp,
	createGitHubAppViaManifest,
	detail,
	githubAppInstallationUrl,
	info,
	ok,
	retry,
	secret,
	secretOrEnv,
	select,
	step,
	text,
	triggerPlatformWorkflow,
	url,
	warn,
} from '@fabrika/installation-init'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { findZone, listZones, resolveAccountId, verifyToken } from './cloudflare'
import { fromEnv, persistEnv, persistEnvBundle } from './envfile'
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
	oidcEnabled: boolean
	passwordEnabled: boolean
	/** OIDC provider issuer IAM federates human login to (discovery URL base). */
	oidcIssuer: string
	/** OIDC client id (public). The placeholder constant when the operator deferred real SSO. */
	oidcClientId: string
	/** Email domains admitted as a human at IAM login (self-provisioning allowlist). */
	humanEmailDomains: string[]
	emailProvider: 'none' | 'resend'
	emailFrom: string
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

/** A resume read off an injectable source, with fromEnv's empty-string-is-absent semantics. */
export function readResumeValue(source: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
	const value = source[name]
	return value === undefined || value === '' ? undefined : value
}

export interface InstallerAuthMethods {
	oidcEnabled: boolean
	passwordEnabled: boolean
}

/** Read a complete, explicit auth-method selection from a resumed init environment. */
export function readInstallerAuthMethods(source: Readonly<Record<string, string | undefined>>): InstallerAuthMethods | undefined {
	const oidc = source['FABRIKA_IAM_OIDC_ENABLED']
	const password = source['FABRIKA_IAM_PASSWORD_ENABLED']
	if ((oidc === undefined || oidc === '') && (password === undefined || password === '')) return undefined
	if (oidc === undefined || oidc === '' || password === undefined || password === '') {
		throw new Error('FABRIKA_IAM_OIDC_ENABLED and FABRIKA_IAM_PASSWORD_ENABLED must be configured together')
	}
	const methods = {
		oidcEnabled: parseBoolean(oidc, 'FABRIKA_IAM_OIDC_ENABLED'),
		passwordEnabled: parseBoolean(password, 'FABRIKA_IAM_PASSWORD_ENABLED'),
	}
	if (!methods.oidcEnabled && !methods.passwordEnabled) {
		throw new Error('At least one IAM authentication method must be enabled')
	}
	return methods
}

/** Read and validate the resumed email provider, if init has already selected one. */
export function readInstallerEmailProvider(source: Readonly<Record<string, string | undefined>>): 'none' | 'resend' | undefined {
	const provider = source['FABRIKA_EMAIL_PROVIDER']
	if (provider === undefined || provider === '') return undefined
	if (provider !== 'none' && provider !== 'resend') {
		throw new Error('FABRIKA_EMAIL_PROVIDER must be none or resend')
	}
	return provider
}

function parseBoolean(value: string, name: string): boolean {
	if (value === 'true') return true
	if (value === 'false') return false
	throw new Error(`${name} must be true or false`)
}

/** Run the full bring-up for `<account>`. */
export async function runInit(account: string): Promise<void> {
	console.log(`\nfabrika platform init — bring up the ${account} Cloudflare control-plane base\n`)

	const collected = await collect(account)
	const vaultKey = await ensureVaultKey()
	const provisioning = await ensureProvisioningKey()
	const operationsSyncKey = await ensureOperationsSyncKey()
	const signingKeys = await ensureSigningKeys()
	const oidcClientSecret = collected.oidcEnabled
		? await ensureOidcClientSecret(collected.oidcClientId === PLACEHOLDER_OIDC_CLIENT_ID)
		: undefined
	const emailApiKey = collected.emailProvider === 'resend' ? await ensureResendApiKey() : undefined
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
			...(oidcClientSecret === undefined ? {} : { FABRIKA_IAM_OIDC_CLIENT_SECRET: oidcClientSecret }),
			...(emailApiKey === undefined ? {} : { FABRIKA_EMAIL_RESEND_API_KEY: emailApiKey }),
		},
		vars: {
			FABRIKA_CONTROL_DOMAIN: collected.controlPlaneDomain,
			OPERATIONS_HOSTNAME: collected.operationsHostname,
			GH_APP_ID: String(app.id),
			FABRIKA_IAM_URL: collected.iamUrl,
			FABRIKA_CONTROL_BOOTSTRAP_ADMINS: JSON.stringify(collected.bootstrapAdmins),
			// IAM Stage 1 non-secret config (read by IAM's fabrika config).
			FABRIKA_IAM_HOSTNAME: collected.iamHostname,
			FABRIKA_IAM_OIDC_ENABLED: String(collected.oidcEnabled),
			FABRIKA_IAM_PASSWORD_ENABLED: String(collected.passwordEnabled),
			FABRIKA_EMAIL_PROVIDER: collected.emailProvider,
			...(collected.oidcEnabled
				? {
					FABRIKA_IAM_OIDC_ISSUER: collected.oidcIssuer,
					FABRIKA_IAM_OIDC_CLIENT_ID: collected.oidcClientId,
					FABRIKA_IAM_HUMAN_EMAIL_DOMAINS: JSON.stringify(collected.humanEmailDomains),
				}
				: {}),
			...(collected.emailProvider === 'resend' ? { FABRIKA_EMAIL_FROM: collected.emailFrom } : {}),
			// The same first-admin emails admit the operator to IAM itself (its own bootstrap hatch).
			FABRIKA_IAM_BOOTSTRAP_ADMINS: JSON.stringify(collected.bootstrapAdmins),
		},
	})

	await triggerDeploy(collected.platformRepo)
	finalNotes(collected.platformRepo, collected.account, dir, await readFabrikaRef(dir), collected.passwordEnabled)
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

	// IAM Stage 1 config: select independent authentication methods, then ask only for the
	// provider-specific values that the selection needs.
	step('IAM auth config (Stage 1)')
	const iamHostname = new URL(iamUrl).host
	ok(`IAM hostname (from URL): ${iamHostname}`)
	const resumedMethods = readInstallerAuthMethods(ENVIRONMENT_SOURCE)
	const methods = resumedMethods
		?? await select<InstallerAuthMethods>('IAM authentication methods', [
			{ label: 'OIDC only', value: { oidcEnabled: true, passwordEnabled: false } },
			{ label: 'Password only', value: { oidcEnabled: false, passwordEnabled: true } },
			{ label: 'OIDC and password', value: { oidcEnabled: true, passwordEnabled: true } },
		])
	await persistEnv('FABRIKA_IAM_OIDC_ENABLED', String(methods.oidcEnabled))
	await persistEnv('FABRIKA_IAM_PASSWORD_ENABLED', String(methods.passwordEnabled))
	if (resumedMethods !== undefined) ok('Reusing IAM authentication methods from .env (resume).')

	let oidcIssuer = ''
	let oidcClientId = ''
	let humanEmailDomains: string[] = []
	if (methods.oidcEnabled) {
		oidcIssuer = fromEnv('FABRIKA_IAM_OIDC_ISSUER') ?? await text('IAM OIDC issuer URL', 'https://accounts.google.com')
		await persistEnv('FABRIKA_IAM_OIDC_ISSUER', oidcIssuer)
		const oidcClientIdRaw = fromEnv('FABRIKA_IAM_OIDC_CLIENT_ID') ?? await text('IAM OIDC client id (blank = placeholder OIDC for now)', '')
		if (oidcClientIdRaw === '') {
			warn('Placeholder OIDC — human SSO login is inert until you set real FABRIKA_IAM_OIDC_CLIENT_ID + _SECRET.')
		}
		oidcClientId = oidcClientIdRaw === '' ? PLACEHOLDER_OIDC_CLIENT_ID : oidcClientIdRaw
		await persistEnv('FABRIKA_IAM_OIDC_CLIENT_ID', oidcClientId)
		const humanRaw = await text('IAM human email domains, comma-separated (who may self-provision at login)', '')
		humanEmailDomains = humanRaw.split(',').map((s) => s.trim()).filter(Boolean)
	}

	const resumedEmailProvider = readInstallerEmailProvider(ENVIRONMENT_SOURCE)
	const emailProvider = resumedEmailProvider
		?? await select<'none' | 'resend'>('Email transport', [
			{ label: 'None (password enrollment and reset stay admin-driven)', value: 'none' },
			{ label: 'Resend', value: 'resend' },
		])
	await persistEnv('FABRIKA_EMAIL_PROVIDER', emailProvider)
	if (resumedEmailProvider !== undefined) ok('Reusing email transport from .env (resume).')
	const emailFrom = emailProvider === 'resend'
		? fromEnv('FABRIKA_EMAIL_FROM')
			?? await retry('Email sender', async () => {
				const value = await text('Email sender (for example Fabrika <auth@example.com>)')
				if (value === '') throw new Error('An email sender is required when Resend is enabled.')
				return value
			})
		: ''
	if (emailProvider === 'resend') await persistEnv('FABRIKA_EMAIL_FROM', emailFrom)

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
		oidcEnabled: methods.oidcEnabled,
		passwordEnabled: methods.passwordEnabled,
		oidcIssuer,
		oidcClientId,
		humanEmailDomains,
		emailProvider,
		emailFrom,
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
	const existing = readResumeValue(dependencies.source, 'FABRIKA_CONTROL_VAULT_KEY')
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
 * pre-set `FABRIKA_IAM_PROVISIONING_KEY` in env and init reuses it.
 */
async function ensureProvisioningKey(): Promise<string> {
	step('Provisioning key (FABRIKA_IAM_PROVISIONING_KEY)')
	const existing = readResumeValue(ENVIRONMENT_SOURCE, 'FABRIKA_IAM_PROVISIONING_KEY')
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
	const existing = readResumeValue(ENVIRONMENT_SOURCE, 'FABRIKA_IAM_SIGNING_KEYS')
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
	const existing = readResumeValue(ENVIRONMENT_SOURCE, 'FABRIKA_IAM_OIDC_CLIENT_SECRET')
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

/** Resolve the Resend API key without ever writing it to user-facing output. */
async function ensureResendApiKey(): Promise<string> {
	step('Resend API key (FABRIKA_EMAIL_RESEND_API_KEY)')
	const existing = fromEnv('FABRIKA_EMAIL_RESEND_API_KEY')
	if (existing !== undefined) {
		ok('Reusing FABRIKA_EMAIL_RESEND_API_KEY from .env (resume).')
		return existing
	}
	const value = await retry('Resend API key', async () => {
		const entered = (await secret('Resend API key')).trim()
		if (entered === '') throw new Error('A Resend API key is required when the provider is enabled.')
		return entered
	})
	await persistEnv('FABRIKA_EMAIL_RESEND_API_KEY', value)
	ok('Resend API key saved to .env.')
	return value
}

const GITHUB_APP_RESUME_ERROR =
	'Stored GitHub App resume state is incomplete or invalid; restore all GitHub App values in .env or remove all five and rerun init'
const GITHUB_APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
const GITHUB_APP_PEM = /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/

const readGitHubAppResume = (source: Readonly<Record<string, string | undefined>>): CreatedGitHubApp | undefined => {
	const pem = readResumeValue(source, 'GITHUB_APP_PRIVATE_KEY')
	const webhookSecret = readResumeValue(source, 'GITHUB_WEBHOOK_SECRET')
	const idText = readResumeValue(source, 'GITHUB_APP_ID')
	const slug = readResumeValue(source, 'GITHUB_APP_SLUG')
	const htmlUrl = readResumeValue(source, 'GITHUB_APP_URL')
	const values = [pem, webhookSecret, idText, slug, htmlUrl]
	if (values.every((value) => value === undefined)) return undefined
	if (pem === undefined || webhookSecret === undefined || idText === undefined || slug === undefined || htmlUrl === undefined) {
		throw new Error(GITHUB_APP_RESUME_ERROR)
	}
	const id = Number(idText)
	let parsedUrl: URL
	try {
		parsedUrl = new URL(htmlUrl)
	} catch {
		throw new Error(GITHUB_APP_RESUME_ERROR)
	}
	if (
		!Number.isSafeInteger(id) || id <= 0 || String(id) !== idText || !GITHUB_APP_SLUG.test(slug)
		|| !GITHUB_APP_PEM.test(pem) || pem.length > 64 * 1024 || webhookSecret.length === 0 || webhookSecret.length > 4096
		|| [...webhookSecret].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
		|| parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com' || parsedUrl.port !== ''
		|| parsedUrl.username !== '' || parsedUrl.password !== '' || parsedUrl.search !== '' || parsedUrl.hash !== ''
		|| parsedUrl.pathname !== `/apps/${slug}`
	) {
		throw new Error(GITHUB_APP_RESUME_ERROR)
	}
	return { id, slug, htmlUrl, pem, webhookSecret }
}

interface GitHubAppInitContext {
	account: string
	controlPlaneDomain: string
	githubOrg: string
	installRepos: string[]
}

interface GitHubAppInitDependencies {
	source: Readonly<Record<string, string | undefined>>
	create: typeof createGitHubAppViaManifest
	persist(values: Readonly<Record<string, string>>): Promise<void>
	appName(defaultValue: string): Promise<string>
	confirmInstallation(question: string, defaultYes: boolean): Promise<boolean>
	installAction(title: string, details: string[]): void
}

const githubAppInitDependencies: GitHubAppInitDependencies = {
	source: ENVIRONMENT_SOURCE,
	create: createGitHubAppViaManifest,
	persist: persistEnvBundle,
	appName: (defaultValue) => text('GitHub App name', defaultValue),
	confirmInstallation: confirm,
	installAction: action,
}

/** Create or resume one complete GitHub App, then require the repository installation grant. */
export async function ensureGitHubApp(
	collected: GitHubAppInitContext,
	dependencies: GitHubAppInitDependencies = githubAppInitDependencies,
): Promise<CreatedGitHubApp> {
	step('Create the fabrika GitHub App (manifest flow)')
	let app = readGitHubAppResume(dependencies.source)
	if (app !== undefined) {
		ok('Reusing the GitHub App from .env (resume) — skipping manifest creation.')
	} else {
		const appName = await dependencies.appName(`fabrika-${collected.account}`)
		const ownerOrg = collected.githubOrg.toLowerCase()
		const isPublic = collected.installRepos.some((repo) => (repo.split('/')[0] ?? '').toLowerCase() !== ownerOrg)
		const controlOrigin = `https://${collected.controlPlaneDomain}`
		app = await dependencies.create({
			organization: collected.githubOrg,
			appName,
			homepageUrl: controlOrigin,
			webhookUrl: `${controlOrigin}/webhooks/github`,
			public: isPublic,
		})
		await dependencies.persist({
			GITHUB_APP_PRIVATE_KEY: app.pem,
			GITHUB_WEBHOOK_SECRET: app.webhookSecret,
			GITHUB_APP_ID: String(app.id),
			GITHUB_APP_SLUG: app.slug,
			GITHUB_APP_URL: app.htmlUrl,
		})
		ok('GitHub App credentials saved to .env (resume-safe).')
	}
	if (collected.installRepos.length > 0) {
		dependencies.installAction('OPERATOR ACTION — install the GitHub App', [
			`1. Open: ${url(githubAppInstallationUrl(app.slug))}`,
			`2. Install it on: ${collected.installRepos.join(', ')}`,
			'3. Grant access to those repositories, then return here.',
		])
		if (!(await dependencies.confirmInstallation('Has the GitHub App been installed on those repositories?', false))) {
			throw new Error('GitHub App installation is required before private repository deploys can run')
		}
	} else {
		detail(`Install the App on the repos fabrika will deploy when you onboard them: ${url(githubAppInstallationUrl(app.slug))}`)
	}
	return app
}

/** Trigger the platform workflow (each deploy builds the runner image into this account's registry). */
async function triggerDeploy(repo: string): Promise<void> {
	step('Trigger the platform deploy (GitHub Actions)')
	info('GitHub Actions runs the real deploy — fabrika runner then control plane. Each run builds the runner')
	info('container image into this account (CI has docker); this laptop deploys nothing.')
	const go = await confirm(`Run the platform workflow on ${repo} now?`, true)
	if (!go) {
		action('OPERATOR ACTION — run it when ready', [
			`gh workflow run platform.yml --repo ${repo}`,
			`or: ${url(`https://github.com/${repo}/actions`)} → platform → Run workflow`,
		])
		return
	}
	await triggerPlatformWorkflow(repo)
	ok('Platform workflow triggered.')
	detail(`Watch: ${url(`https://github.com/${repo}/actions`)}   (or: gh run watch --repo ${repo})`)
}

/** Closing notes: the local checkout, the escape hatch, and what runs in CI. */
function finalNotes(repo: string, account: string, dir: string, ref: string, passwordEnabled: boolean): void {
	step('Done')
	ok(`Base repo: ${repo} (pinned fabrika ref: ${ref})`)
	ok(`Local checkout + .env: ${dir}`)
	info('The fabrika control plane came up with the bootstrap-admin escape hatch OPEN (FABRIKA_CONTROL_BOOTSTRAP_ADMINS set).')
	action('OPERATOR ACTION — close the hatch after IAM grants you the fabrika admin role', [
		`1. gh variable set FABRIKA_CONTROL_BOOTSTRAP_ADMINS --repo ${repo} --env ${account} --body '[]'`,
		`2. gh workflow run platform.yml --repo ${repo}`,
		'3. Authorization is then fully IAM-owned.',
	])
	if (passwordEnabled) {
		action('OPERATOR ACTION — enroll the first password user through IAM provisioning', [
			'Password enrollment is provisioning-backed; the installer does not print or invent an administrative credential.',
			'Use the IAM admin surface after the first provisioning-backed administrator is available.',
		])
	}
}
