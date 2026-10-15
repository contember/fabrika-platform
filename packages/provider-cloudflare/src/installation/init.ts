/**
 * `fabrika platform init --provider=cloudflare <account>` — bring up a CF account's fabrika control-plane base.
 * Idempotent + resumable (every captured value lands in the per-account env file `openEnvFile` binds and
 * reloads). The REAL deploy runs in GitHub Actions (the scaffolded pipeline calls `fabrika platform deploy`),
 * so this machine never needs the CF toolchain or docker.
 *
 * It prompts for nothing: every input is a flag or an environment variable (`init-options.ts`). What stays
 * is one confirmation before each step that cannot be taken back, answered by `--yes` when nobody watches.
 *
 * Order: CF token → account + zones → IAM and email config → vault key → provisioning key → runner key →
 * scaffold the base repo → write the GitHub Environment → trigger. Secret VALUES flow only into the env
 * file, `gh` over stdin, and child env — never through `log.ts`. GitHub source connections are made later
 * from the console (ADR-0029); init creates no GitHub App.
 */

import {
	action,
	branchProtectionCommand,
	configureEnvironment,
	type Confirmations,
	confirmations,
	detail,
	type EnvironmentConfig,
	ghRepoExists,
	info,
	type InstallationEmail,
	ok,
	type ProtectionOutcome,
	step,
	triggerPlatformWorkflow,
	url,
	warn,
} from '@fabrika/installation-init'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { type CfAccount, type CfZone, findZone, listAccounts, selectAccount, verifyToken } from './cloudflare'
import { envPath, fromEnv, openEnvFile, persistEnv } from './envfile'
import { type InitInput, parseInitAccount, parseInitArgs, PLACEHOLDER_OIDC_CLIENT_ID, rerunCommand } from './init-options'
import { readFabrikaRef, type ScaffoldInput, scaffoldPlatformRepo, type ScaffoldResult } from './scaffold'

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
	/** IAM's mail transport. */
	email: InstallationEmail
	bootstrapAdmins: string[]
}

const ENVIRONMENT_SOURCE: Readonly<Record<string, string | undefined>> = process.env

/** A resume read off an injectable source, with fromEnv's empty-string-is-absent semantics. */
export function readResumeValue(source: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
	const value = source[name]
	return value === undefined || value === '' ? undefined : value
}

/** Everything `runInit` does outside this machine. Each GitHub write is confirmed first. */
export interface InitEffects {
	/** Only decides how the scaffold confirmation is phrased; the scaffold itself re-reads it. */
	repositoryExists(repo: string): Promise<boolean>
	listAccounts(token: string): Promise<CfAccount[]>
	/** Best effort: `false` means "could not confirm", never "invalid". */
	verifyToken(token: string, accountId: string): Promise<boolean>
	findZone(token: string, hostname: string): Promise<CfZone | null>
	scaffold(input: ScaffoldInput): Promise<ScaffoldResult>
	configureEnvironment(config: EnvironmentConfig): Promise<void>
	triggerWorkflow(repo: string): Promise<void>
}

export interface InitCollaborators {
	readonly prompts: Confirmations
	readonly effects: InitEffects
}

/** `platform init` from its command line: open the account's env file, parse against it, run. */
export async function initCommand(argv: readonly string[]): Promise<void> {
	const account = parseInitAccount(argv)
	console.log(`\nfabrika platform init — bring up the ${account} Cloudflare control-plane base\n`)
	step('Open the installer env file')
	info(`Every captured value is persisted here (0600, in a 0700 directory) so a re-run resumes: ${await openEnvFile(account)}`)
	const input = parseInitArgs(argv, process.env)
	await runInit(input, consoleInitCollaborators(input))
}

/** Run the full bring-up. The installer env file must already be open (`openEnvFile`). */
export async function runInit(input: InitInput, collaborators: InitCollaborators): Promise<void> {
	const cfAccount = await verifiedAccount(input, collaborators)
	if (cfAccount === undefined) {
		return
	}
	const collected = await collect(input, cfAccount, collaborators.effects)
	const vaultKey = await ensureVaultKey()
	const provisioning = await ensureProvisioningKey()
	const operationsSyncKey = await ensureOperationsSyncKey()
	const signingKeys = await ensureSigningKeys()
	const oidcClientSecret = input.oidc === undefined ? undefined : await ensureOidcClientSecret(input.oidc.clientSecret)
	const runnerKey = await ensureRunnerKey()

	const { prompts, effects } = collaborators
	const rerun = rerunCommand(input, collected.accountId)

	step('Scaffold the platform repository')
	const question = (await effects.repositoryExists(collected.platformRepo))
		? `Refresh the platform pipeline on ${collected.platformRepo} and push?`
		: `Create ${collected.platformRepo} (private) on GitHub and push the platform pipeline?`
	if (!(await prompts.confirm(question, true))) {
		action('OPERATOR ACTION — nothing was pushed to GitHub; run init again when ready', [rerun])
		return
	}
	const { dir, branchProtection } = await effects.scaffold({
		repo: collected.platformRepo,
		account: collected.account,
		dir: input.checkout,
	})

	let environmentPolicy: ProtectionOutcome | undefined
	const environment: EnvironmentConfig = {
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
		}),
	}
	info(
		`${Object.keys(environment.secrets).length} secret(s) and ${
			Object.keys(environment.vars).length
		} variable(s) for the ${collected.account} Environment.`,
	)
	if (!(await prompts.confirm(`Write them to the ${collected.account} Environment now (secret VALUES go to GitHub over \`gh\` stdin)?`, true))) {
		action('OPERATOR ACTION — the pipeline cannot run until the Environment holds these; run init again when ready', [rerun])
		return
	}
	await effects.configureEnvironment(environment)

	await triggerDeploy(collected.platformRepo, collaborators)
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

/** The real collaborators: a TTY (or `--yes`), the Cloudflare API, `gh` and git. */
export function consoleInitCollaborators(input: InitInput): InitCollaborators {
	return {
		// Before anything is contacted: a run nobody can confirm does not start.
		prompts: confirmations(
			input.unattended,
			process.stdin,
			(line) => info(line),
			'creates or pushes the platform repository, writes its GitHub Environment secrets and triggers the platform workflow',
		),
		effects: {
			repositoryExists: (repo) => ghRepoExists(repo),
			listAccounts: (token) => listAccounts(token),
			verifyToken: (token, accountId) => verifyToken(token, accountId),
			findZone: (token, hostname) => findZone(token, hostname),
			scaffold: (scaffoldInput) => scaffoldPlatformRepo(scaffoldInput),
			configureEnvironment: (config) => configureEnvironment(config),
			triggerWorkflow: (repo) => triggerPlatformWorkflow(repo),
		},
	}
}

/** Everything `init` generated or fetched, ready to be split into the Environment's two halves. */
export interface GeneratedInstallation {
	readonly vaultKey: string
	readonly provisioning: string
	readonly operationsSyncKey: string
	readonly runnerKey: string
	readonly signingKeys: string
	readonly oidcClientSecret?: string
}

/**
 * What the GitHub Environment holds, split by the one rule: a credential is a SECRET, never a variable
 * (a variable value reaches `gh` on argv).
 */
export function environmentPayload(
	collected: Collected,
	generated: GeneratedInstallation,
): { secrets: Record<string, string>; vars: Record<string, string> } {
	const email = collected.email.kind === 'none' ? { secrets: {}, vars: { FABRIKA_EMAIL_PROVIDER: 'none' } } : splitEmail(collected.email)
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
			...email.secrets,
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
			...email.vars,
			...(collected.oidcEnabled
				? {
					FABRIKA_IAM_OIDC_ISSUER: collected.oidcIssuer,
					FABRIKA_IAM_OIDC_CLIENT_ID: collected.oidcClientId,
					FABRIKA_IAM_HUMAN_EMAIL_DOMAINS: JSON.stringify(collected.humanEmailDomains),
				}
				: {}),
			// The same first-admin emails admit the operator to IAM itself (its own bootstrap hatch).
			FABRIKA_IAM_BOOTSTRAP_ADMINS: JSON.stringify(collected.bootstrapAdmins),
		},
	}
}

/** The provider's secret variables go to the Environment's secrets, the rest to its variables. */
function splitEmail(email: Extract<InstallationEmail, { kind: 'provider' }>): { secrets: Record<string, string>; vars: Record<string, string> } {
	const secrets: Record<string, string> = {}
	const vars: Record<string, string> = {}
	for (const [name, value] of email.variables) {
		if (email.secretNames.has(name)) secrets[name] = value
		else vars[name] = value
	}
	return { secrets, vars }
}

/**
 * Resolve the account the token deploys into and check the token against it.
 *
 * Returns `undefined` when the operator declines an unverified token: nothing has been written then.
 */
async function verifiedAccount(input: InitInput, { prompts, effects }: InitCollaborators): Promise<CfAccount | undefined> {
	step('Cloudflare API token')
	info("Read from CLOUDFLARE_API_TOKEN. It authenticates the deploy AND becomes the control plane's runtime CLOUDFLARE_API_TOKEN secret.")
	detail(`Resolving the Cloudflare account for this token (${input.apiToken.length} chars)…`)
	// An unreadable list is not fatal: an account-owned token typically cannot list its own account.
	const accounts = await effects.listAccounts(input.apiToken).catch((): CfAccount[] => [])
	const cfAccount = selectAccount(accounts, input.accountId)
	if (await effects.verifyToken(input.apiToken, cfAccount.id)) {
		ok('Token verified (status active).')
	} else {
		warn('Could not pre-verify the token via the Cloudflare API.')
		detail('Expected for some account-owned tokens (invisible to /user/tokens/verify); the deploy validates it for real.')
		if (!(await prompts.confirm('Proceed anyway?', true))) {
			action('OPERATOR ACTION — nothing was written; check CLOUDFLARE_API_TOKEN, then run init again', [rerunCommand(input, cfAccount.id)])
			return undefined
		}
	}
	ok(`Account: ${cfAccount.name} (${cfAccount.id})`)
	await persistEnv('CLOUDFLARE_API_TOKEN', input.apiToken)
	await persistEnv('CLOUDFLARE_ACCOUNT_ID', cfAccount.id)
	return cfAccount
}

/** Warn — never fail — when no zone covers `hostname`: the operator may add it before the deploy. */
async function checkZone(effects: InitEffects, token: string, hostname: string, consequence: string): Promise<void> {
	const zone = await effects.findZone(token, hostname).catch(() => null)
	if (zone === null) {
		warn(`No Cloudflare zone found for ${hostname} — ${consequence}`)
	} else {
		ok(`Zone found: ${zone.name}`)
	}
}

/** Check the hosts against the account's zones and persist the resumable selections. */
async function collect(input: InitInput, cfAccount: CfAccount, effects: InitEffects): Promise<Collected> {
	step('Account details')
	ok(`Platform repo: ${input.repo}`)
	ok(`fabrika control-plane domain: ${input.hosts.control}`)
	await checkZone(effects, input.apiToken, input.hosts.control, 'a custom-domain bind would fail. Add the zone before the deploy.')
	ok(`Operations ingest domain: ${input.hosts.operations}`)
	await checkZone(effects, input.apiToken, input.hosts.operations, 'the Operations custom-domain bind would fail.')
	if (input.bootstrapAdmins.length === 0) {
		warn('No first admin (--admins / FABRIKA_CONTROL_BOOTSTRAP_ADMINS): nobody is admitted through the escape hatch.')
	} else {
		ok(`First admins: ${input.bootstrapAdmins.join(', ')}`)
	}

	step('IAM auth config (Stage 1)')
	ok(`IAM hostname: ${input.hosts.iam}`)
	const oidc = input.oidc
	await persistEnv('FABRIKA_IAM_OIDC_ENABLED', String(oidc !== undefined))
	await persistEnv('FABRIKA_IAM_PASSWORD_ENABLED', String(input.passwordEnabled))
	if (oidc !== undefined) {
		await persistEnv('FABRIKA_IAM_OIDC_ISSUER', oidc.issuer)
		if (oidc.clientId === PLACEHOLDER_OIDC_CLIENT_ID) {
			warn('Placeholder OIDC — human SSO login is inert until you set real FABRIKA_IAM_OIDC_CLIENT_ID + _SECRET.')
		}
		await persistEnv('FABRIKA_IAM_OIDC_CLIENT_ID', oidc.clientId)
	}
	await ensureEmailSettings(input.email)

	return {
		account: input.account,
		accountId: cfAccount.id,
		apiToken: input.apiToken,
		controlPlaneDomain: input.hosts.control,
		operationsHostname: input.hosts.operations,
		platformRepo: input.repo,
		iamUrl: `https://${input.hosts.iam}`,
		iamHostname: input.hosts.iam,
		oidcEnabled: oidc !== undefined,
		passwordEnabled: input.passwordEnabled,
		oidcIssuer: oidc?.issuer ?? '',
		oidcClientId: oidc?.clientId ?? '',
		humanEmailDomains: oidc === undefined ? [] : [...oidc.humanEmailDomains],
		email: input.email,
		bootstrapAdmins: [...input.bootstrapAdmins],
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
 * Persist IAM's OIDC client secret (Stage 1) — the real one from the environment, or the placeholder
 * paired with the placeholder client id — so a re-run reuses it. NEVER logged.
 */
async function ensureOidcClientSecret(value: string): Promise<string> {
	step('IAM OIDC client secret (FABRIKA_IAM_OIDC_CLIENT_SECRET)')
	await persistEnv('FABRIKA_IAM_OIDC_CLIENT_SECRET', value)
	ok('OIDC client secret saved to the installer env file.')
	return value
}

/** Persist every mail setting, credentials included, so a re-run reuses them; logs names, never a value. */
async function ensureEmailSettings(email: InstallationEmail): Promise<void> {
	if (email.kind === 'none') {
		await persistEnv('FABRIKA_EMAIL_PROVIDER', 'none')
		return
	}
	for (const [name, value] of email.variables) await persistEnv(name, value)
	ok(`Mail transport saved to the installer env file: ${[...email.variables.keys()].join(', ')}.`)
}

/** Trigger the platform workflow (each deploy builds the runner image into this account's registry). */
async function triggerDeploy(repo: string, { prompts, effects }: InitCollaborators): Promise<void> {
	step('Trigger the platform deploy (GitHub Actions)')
	info('GitHub Actions runs the real deploy — fabrika runner then control plane. Each run builds the runner')
	info('container image into this account (CI has docker); this machine deploys nothing.')
	if (!(await prompts.confirm(`Run the platform workflow on ${repo} now?`, true))) {
		action('OPERATOR ACTION — run it when ready', [
			`gh workflow run platform.yml --repo ${repo}`,
			`or: ${url(`https://github.com/${repo}/actions`)} → platform → Run workflow`,
		])
		return
	}
	await effects.triggerWorkflow(repo)
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
