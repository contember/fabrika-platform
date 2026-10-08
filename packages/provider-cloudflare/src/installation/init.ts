/**
 * `fabrika platform init --provider=cloudflare <account>` — bring up a CF account's fabrika control-plane base from (ideally) just a
 * Cloudflare API token. Idempotent + resumable (every captured value lands in the per-account env file
 * `openEnvFile` binds and reloads). The REAL deploy runs in GitHub Actions (the scaffolded pipeline calls
 * `fabrika platform deploy`), so this laptop never needs the CF toolchain or docker.
 *
 * Order: CF token → account + zones → smart-default prompts → vault key → provisioning key → runner key →
 * scaffold the base repo → write the GitHub Environment → trigger. Secret VALUES flow only into the env
 * file, `gh` over stdin, and child env — never through `log.ts`. GitHub source connections are made later
 * from the console (ADR-0029); init creates no GitHub App.
 */

import {
	action,
	branchProtectionCommand,
	configureEnvironment,
	confirm,
	detail,
	info,
	ok,
	type ProtectionOutcome,
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
import { envPath, fromEnv, openEnvFile, persistEnv } from './envfile'
import { defaultCheckoutDir, readFabrikaRef, scaffoldPlatformRepo } from './scaffold'

/** Everything collected before the scaffold + environment write. */
export interface Collected {
	account: string
	accountId: string
	apiToken: string
	controlPlaneDomain: string
	operationsHostname: string
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

	step('Open the installer env file')
	info(`Every captured value is persisted here (0600, in a 0700 directory) so a re-run resumes: ${await openEnvFile(account)}`)

	const collected = await collect(account)
	const vaultKey = await ensureVaultKey()
	const provisioning = await ensureProvisioningKey()
	const operationsSyncKey = await ensureOperationsSyncKey()
	const signingKeys = await ensureSigningKeys()
	const oidcClientSecret = collected.oidcEnabled
		? await ensureOidcClientSecret(collected.oidcClientId === PLACEHOLDER_OIDC_CLIENT_ID)
		: undefined
	const emailApiKey = collected.emailProvider === 'resend' ? await ensureResendApiKey() : undefined
	const runnerKey = await ensureRunnerKey()

	const { dir, branchProtection } = await scaffoldPlatformRepo({
		repo: collected.platformRepo,
		account: collected.account,
		dir: defaultCheckoutDir(collected.account),
	})
	let environmentPolicy: ProtectionOutcome | undefined

	await configureEnvironment({
		repo: collected.platformRepo,
		environment: collected.account,
		onProtection: (outcome) => {
			environmentPolicy = outcome
		},
		...environmentPayload(collected, {
			vaultKey,
			provisioning,
			operationsSyncKey,
			runnerKey,
			signingKeys,
			...(oidcClientSecret === undefined ? {} : { oidcClientSecret }),
			...(emailApiKey === undefined ? {} : { emailApiKey }),
		}),
	})

	await triggerDeploy(collected.platformRepo)
	finalNotes({
		repo: collected.platformRepo,
		account: collected.account,
		controlPlaneDomain: collected.controlPlaneDomain,
		dir,
		ref: await readFabrikaRef(dir),
		passwordEnabled: collected.passwordEnabled,
		...(branchProtection === undefined ? {} : { branchProtection }),
		...(environmentPolicy === undefined ? {} : { environmentPolicy }),
	})
}

/** Everything `init` generated or fetched, ready to be split into the Environment's two halves. */
export interface GeneratedInstallation {
	readonly vaultKey: string
	readonly provisioning: string
	readonly operationsSyncKey: string
	readonly runnerKey: string
	readonly signingKeys: string
	readonly oidcClientSecret?: string
	readonly emailApiKey?: string
}

/**
 * What the GitHub Environment holds, split by the one rule: a credential is a SECRET, never a variable
 * (a variable value reaches `gh` on argv).
 */
export function environmentPayload(
	collected: Collected,
	generated: GeneratedInstallation,
): { secrets: Record<string, string>; vars: Record<string, string> } {
	return {
		secrets: {
			CLOUDFLARE_ACCOUNT_ID: collected.accountId,
			CLOUDFLARE_API_TOKEN: collected.apiToken,
			FABRIKA_CONTROL_VAULT_KEY: generated.vaultKey,
			FABRIKA_IAM_PROVISIONING_KEY: generated.provisioning,
			OPERATIONS_SYNC_KEY: generated.operationsSyncKey,
			// The shared key the control plane presents to the deploy runner; both Workers take the same value.
			FABRIKA_RUNNER_KEY: generated.runnerKey,
			// IAM Stage 1 native-auth secrets (pushed as IAM Worker secrets by the pipeline).
			FABRIKA_IAM_SIGNING_KEYS: generated.signingKeys,
			...(generated.oidcClientSecret === undefined ? {} : { FABRIKA_IAM_OIDC_CLIENT_SECRET: generated.oidcClientSecret }),
			...(generated.emailApiKey === undefined ? {} : { FABRIKA_EMAIL_RESEND_API_KEY: generated.emailApiKey }),
		},
		vars: {
			FABRIKA_CONTROL_DOMAIN: collected.controlPlaneDomain,
			OPERATIONS_HOSTNAME: collected.operationsHostname,
			FABRIKA_IAM_ISSUER: collected.iamUrl,
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
	}
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
	const githubOrg = await text('GitHub org that owns the platform repo', account)
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
	if (resumedMethods !== undefined) ok('Reusing IAM authentication methods from the installer env file (resume).')

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
	if (resumedEmailProvider !== undefined) ok('Reusing email transport from the installer env file (resume).')
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
		ok('Reusing FABRIKA_CONTROL_VAULT_KEY from the installer env file (resume).')
		return existing
	}
	const key = dependencies.generate()
	await dependencies.persist('FABRIKA_CONTROL_VAULT_KEY', key)
	dependencies.created('SAVED to the installer env file — copy it to your password manager; the vault KEK is unrecoverable if lost', [
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
		ok('Reusing the provisioning key from the installer env file (resume).')
		return existing
	}
	const key = `px_${randomBytes(20).toString('base64url')}`
	await persistEnv('FABRIKA_IAM_PROVISIONING_KEY', key)
	ok('Provisioning key generated + saved to the installer env file.')
	detail('IAM Stage 1 seeds this as an admin credential; the control plane reconciles with it in Stage 2.')
	return key
}

async function ensureOperationsSyncKey(): Promise<string> {
	step('Operations catalog key (OPERATIONS_SYNC_KEY)')
	const existing = fromEnv('OPERATIONS_SYNC_KEY')
	if (existing !== undefined) {
		if (existing.length < 32) throw new Error('OPERATIONS_SYNC_KEY must be at least 32 characters.')
		ok('Reusing OPERATIONS_SYNC_KEY from the installer env file (resume).')
		return existing
	}
	const key = randomBytes(32).toString('base64url')
	await persistEnv('OPERATIONS_SYNC_KEY', key)
	ok('Operations catalog key generated + saved to the installer env file.')
	return key
}

/**
 * Generate the runner key: the shared 256-bit bearer the control plane presents to the deploy executor,
 * whose service binding alone proves nothing about the caller. The SAME value is pushed to both Workers,
 * so it must be durable — a resumed init reuses it rather than rolling half the pair.
 */
export async function ensureRunnerKey(): Promise<string> {
	step('Runner key (FABRIKA_RUNNER_KEY)')
	const existing = readResumeValue(ENVIRONMENT_SOURCE, 'FABRIKA_RUNNER_KEY')
	if (existing !== undefined) {
		await persistEnv('FABRIKA_RUNNER_KEY', existing)
		ok('Reusing FABRIKA_RUNNER_KEY from the installer env file (resume).')
		return existing
	}
	const key = randomBytes(32).toString('base64url')
	await persistEnv('FABRIKA_RUNNER_KEY', key)
	ok('Runner key generated + saved to the installer env file.')
	detail('The pipeline pushes it to the control plane and the deploy runner as a Worker secret.')
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
		ok('Reusing FABRIKA_IAM_SIGNING_KEYS from the installer env file (resume).')
		return existing
	}
	const keys = JSON.stringify([generateEs256Jwk()])
	await persistEnv('FABRIKA_IAM_SIGNING_KEYS', keys)
	ok('IAM signing key generated (1 × ES256) + saved to the installer env file.')
	return keys
}

/**
 * Resolve IAM's OIDC client secret (Stage 1). Reused from the installer env file on resume; otherwise a hidden
 * prompt for a real provider, or the placeholder when SSO was deferred (blank client id). Always persisted
 * so a re-run reuses it. NEVER logged.
 */
async function ensureOidcClientSecret(placeholder: boolean): Promise<string> {
	step('IAM OIDC client secret (FABRIKA_IAM_OIDC_CLIENT_SECRET)')
	const existing = readResumeValue(ENVIRONMENT_SOURCE, 'FABRIKA_IAM_OIDC_CLIENT_SECRET')
	if (existing !== undefined) {
		await persistEnv('FABRIKA_IAM_OIDC_CLIENT_SECRET', existing)
		ok('Reusing FABRIKA_IAM_OIDC_CLIENT_SECRET from the installer env file (resume).')
		return existing
	}
	const value = placeholder ? PLACEHOLDER_OIDC_CLIENT_SECRET : await secret('IAM OIDC client secret')
	await persistEnv('FABRIKA_IAM_OIDC_CLIENT_SECRET', value)
	ok(placeholder ? 'Placeholder OIDC client secret saved to the installer env file.' : 'OIDC client secret saved to the installer env file.')
	return value
}

/** Resolve the Resend API key without ever writing it to user-facing output. */
async function ensureResendApiKey(): Promise<string> {
	step('Resend API key (FABRIKA_EMAIL_RESEND_API_KEY)')
	const existing = fromEnv('FABRIKA_EMAIL_RESEND_API_KEY')
	if (existing !== undefined) {
		ok('Reusing FABRIKA_EMAIL_RESEND_API_KEY from the installer env file (resume).')
		return existing
	}
	const value = await retry('Resend API key', async () => {
		const entered = (await secret('Resend API key')).trim()
		if (entered === '') throw new Error('A Resend API key is required when the provider is enabled.')
		return entered
	})
	await persistEnv('FABRIKA_EMAIL_RESEND_API_KEY', value)
	ok('Resend API key saved to the installer env file.')
	return value
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

/** What the closing summary reports beyond the repository itself. */
export interface FinalNotes {
	readonly repo: string
	readonly account: string
	readonly controlPlaneDomain: string
	readonly dir: string
	readonly ref: string
	readonly passwordEnabled: boolean
	/** Absent when the repository already existed, so this run did not touch its protection. */
	readonly branchProtection?: ProtectionOutcome
	readonly environmentPolicy?: ProtectionOutcome
}

/** Closing notes: the checkout, the env file, what is protected, the escape hatch, and what runs in CI. */
export function finalNotes(notes: FinalNotes): void {
	const { repo, account, controlPlaneDomain, dir, ref, passwordEnabled } = notes
	step('Done')
	ok(`Base repo: ${repo} (pinned fabrika ref: ${ref})`)
	ok(`Local checkout: ${dir}`)
	ok(`Installer env file (0600): ${envPath()}`)
	reportProtection('Branch protection on main', notes.branchProtection, 'not checked')
	reportEnvironmentPolicy(repo, notes.environmentPolicy, notes.branchProtection)
	info('The fabrika control plane came up with the bootstrap-admin escape hatch OPEN (FABRIKA_CONTROL_BOOTSTRAP_ADMINS set).')
	action('OPERATOR ACTION — close the hatch after IAM grants you the fabrika admin role', [
		`1. gh variable set FABRIKA_CONTROL_BOOTSTRAP_ADMINS --repo ${repo} --env ${account} --body '[]'`,
		`2. gh workflow run platform.yml --repo ${repo}`,
		'3. Authorization is then fully IAM-owned.',
	])
	info('Public repositories deploy without a GitHub App. Connect private GitHub source in Control.')
	action('OPERATOR ACTION — connect GitHub source in Control once the deploy is live', [url(`https://${controlPlaneDomain}/settings/source`)])
	if (passwordEnabled) {
		action('OPERATOR ACTION — enroll the first password user through IAM provisioning', [
			'Password enrollment is provisioning-backed; the installer does not print or invent an administrative credential.',
			'Use the IAM admin surface after the first provisioning-backed administrator is available.',
		])
	}
}

/** One line per hardening rule: applied, or what is open and the command that closes it. */
function reportProtection(label: string, outcome: ProtectionOutcome | undefined, absent: string): void {
	if (outcome === undefined) {
		info(`${label}: ${absent}.`)
		return
	}
	if (outcome.applied) {
		ok(`${label}: applied.`)
		return
	}
	warn(`${label}: NOT applied (${outcome.reason ?? 'refused'}).`)
	detail(`Apply it later: ${outcome.command}`)
}

/**
 * `protected_branches` admits every branch that carries no protection rule, so the Environment policy is
 * worth nothing until `main` is protected. Never report the policy as sufficient on its own.
 */
function reportEnvironmentPolicy(repo: string, policy: ProtectionOutcome | undefined, branch: ProtectionOutcome | undefined): void {
	const label = 'Environment deployment-branch policy'
	if (policy?.applied === true && branch?.applied !== true) {
		warn(`${label}: applied, but it restricts nothing until main carries a protection rule.`)
		detail(`Protect main first: ${branch?.command ?? branchProtectionCommand(repo)}`)
		return
	}
	reportProtection(label, policy, 'not attempted')
}
