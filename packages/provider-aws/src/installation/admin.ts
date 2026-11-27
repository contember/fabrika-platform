// `fabrika platform admin --provider=aws` (the AWS idea's checklist, step 11, the commands' step): once the platform's
// hosts point at its balancer, register the console and IAM's own vocabulary with IAM, and admit the first
// administrator. The mechanics are `installation-init`'s and `@fabrika/auth`'s, the same as on Zerops; what is AWS's
// is where the installation answers and which credential reaches IAM.
//
// - **No key on a command line or in a file.** IAM's provisioning key is read from the installation's own Parameter
//   Store with the operator's credentials, the account checked first, and never printed or logged.
// - **The hosts from the installation's record** (`record.ts`), so the command takes the account, the region and the
//   administrator's mailbox alone.
// - **Idempotent.** Each step finds what is there before it adds: a re-run admits nobody twice and issues no second
//   enrollment unless `--reissue` says so. It asks nothing.
// - **The enrollment URL** sets the first password, so it is a credential: printed once on stdout on a line of its
//   own, never logged, stored nowhere.
//
// `platform upgrade` registers the console and IAM's vocabulary too (`registerAwsPlatformApps`), since a release may
// change them; an install cannot, before its hosts point anywhere.

import { reconcileSchema, ReconcileSchemaError } from '@fabrika/auth'
import { IAM_APP_ID, IAM_APP_SCHEMA } from '@fabrika/iam-contract'
import {
	createIamAdminClient,
	describeArgument,
	ensureFirstAdministrator,
	type FirstAdministratorRequest,
	type FirstAdministratorResult,
	platformOrigin,
	platformProxyAppFor,
	requiredSetting,
	setting,
} from '@fabrika/installation-init'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import type { SsmPlatformSecrets } from '../aws/ssm'
import type { StsClient } from '../aws/sts'
import type { AwsPlatformPlan } from './apply'
import { PLATFORM_CONSOLE_APP_SCHEMA } from './generated/platform-console-schema'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from './generated/platform-proxy-manifest'
import { AWS_INSTALLATION_RECORD, parseAwsInstallationRecord } from './record'
import { AWS_ACCOUNT_ID_FORM, AWS_REGION_FORM, awsPlatformParameters } from './runtime'

/** IAM's provisioning key, as `parameters.ts` writes it under IAM's own path. */
export const AWS_PROVISIONING_KEY_PARAMETER = `${awsPlatformParameters('iam')}FABRIKA_IAM_PROVISIONING_KEY`
/** Replace an outstanding enrollment instead of reporting it: the one way a second URL is ever issued. */
export const AWS_REISSUE_FLAG = '--reissue'

/**
 * IAM gave no answer at all: the host resolves nowhere, refuses the connection, or completes no TLS. An upgrade that
 * finishes an install whose hosts point nowhere yet meets this, and names `admin` instead of failing; an answer from
 * IAM (a refused key, any status) is a `ReconcileSchemaError` and always fails.
 */
export class AwsIamUnreachableError extends Error {
	readonly origin: string
	constructor(origin: string, reason: string) {
		super(`aws: IAM at ${origin} gave no answer (${reason})`)
		this.name = 'AwsIamUnreachableError'
		this.origin = origin
	}
}

/** The reconciler `@fabrika/auth` gives: IAM's provisioning surface over the network. */
export const awsSchemaReconciler: SchemaReconciler = async (call) => {
	try {
		await reconcileSchema({
			url: call.url,
			app: call.app,
			schema: call.schema,
			...(call.returnOrigins === undefined ? {} : { returnOrigins: call.returnOrigins }),
			...(call.adminKey === undefined ? {} : { adminKey: call.adminKey }),
			signal: call.signal,
		})
	} catch (error) {
		// Only the request itself failing is "no answer"; the error's own message names no credential (the key travels
		// in a header, never in the URL), and the error object is not kept.
		if (error instanceof ReconcileSchemaError || call.signal.aborted) throw error
		throw new AwsIamUnreachableError(call.url, error instanceof Error ? error.message : 'the request failed')
	}
}

/**
 * Registers the console (its vocabulary, and the console's origin as the one a session may return to) and IAM's own
 * vocabulary with the installation's IAM. The schema's write is what registers an app, so the return origin travels in
 * the same call.
 */
export async function registerAwsPlatformApps(input: {
	readonly plan: Pick<AwsPlatformPlan, 'hosts'>
	readonly provisioningKey: string
	readonly reconcile: SchemaReconciler
	readonly signal: AbortSignal
	readonly log: (line: string) => void
}): Promise<void> {
	const { plan, provisioningKey, signal } = input
	const iam = platformOrigin('https', plan.hosts.iam)
	const consoleApp = platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control')
	const consoleOrigin = platformOrigin('https', plan.hosts.control)
	await input.reconcile({
		url: iam,
		app: consoleApp.id,
		schema: PLATFORM_CONSOLE_APP_SCHEMA,
		returnOrigins: [consoleOrigin],
		adminKey: provisioningKey,
		signal,
	})
	input.log(`aws: registered \`${consoleApp.id}\` with IAM; its sessions return to ${consoleOrigin}`)
	await input.reconcile({ url: iam, app: IAM_APP_ID, schema: IAM_APP_SCHEMA, adminKey: provisioningKey, signal })
	input.log(`aws: registered \`${IAM_APP_ID}\`'s own vocabulary`)
}

/** IAM's provisioning key from the installation's Parameter Store; refused, by its parameter, when it is missing. */
export async function awsProvisioningKey(secrets: Pick<SsmPlatformSecrets, 'readSecret'>, signal: AbortSignal): Promise<string> {
	const key = await secrets.readSecret(AWS_PROVISIONING_KEY_PARAMETER, signal)
	if (key === null) throw new Error(`aws: ${AWS_PROVISIONING_KEY_PARAMETER} is missing; restore it from the keys' backup`)
	return key
}

export interface AwsAdminOptions {
	readonly accountId: string
	readonly region: string
	/** The mailbox that identifies the first administrator. */
	readonly email: string
	readonly reissue: boolean
}

const ADMIN_FLAGS: readonly (readonly [string, string])[] = [
	['--account-id', 'FABRIKA_AWS_ACCOUNT_ID'],
	['--region', 'FABRIKA_AWS_REGION'],
	['--email', 'FABRIKA_PLATFORM_ADMIN_EMAIL'],
]

/** `admin`'s arguments: the account, the region, the mailbox, and `--reissue`. */
export function parseAwsAdminArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): AwsAdminOptions {
	// `--reissue` bare, every other flag as `--flag=value`, as Zerops' `admin` takes them: a `--reissue=yes` read as no
	// reissue, or a value standing apart from its flag, is refused rather than guessed.
	for (const arg of argv) {
		if (arg === AWS_REISSUE_FLAG) continue
		const name = arg.split('=')[0] ?? arg
		if (name === AWS_REISSUE_FLAG) throw new Error(`${AWS_REISSUE_FLAG} takes no value`)
		if (!ADMIN_FLAGS.some(([flag]) => flag === name)) throw new Error(`${describeArgument(arg)} is not an argument of this command`)
		if (!arg.includes('=')) throw new Error(`${name} takes its value as ${name}=<value>`)
	}
	const [account, region, email] = ADMIN_FLAGS.map(([flag, variable]) => requiredSetting(setting(argv, env, flag, variable), flag, variable))
	if (account === undefined || region === undefined || email === undefined) {
		throw new Error('aws: the account, the region and the mailbox are required')
	}
	if (!AWS_ACCOUNT_ID_FORM.test(account)) throw new Error('--account-id is not an account id (12 digits)')
	if (!AWS_REGION_FORM.test(region)) throw new Error('--region is not a region name (eu-central-1)')
	return { accountId: account, region, email, reissue: argv.includes(AWS_REISSUE_FLAG) }
}

export interface AwsAdminRun {
	readonly options: AwsAdminOptions
	readonly sts: Pick<StsClient, 'callerAccount'>
	readonly secrets: Pick<SsmPlatformSecrets, 'readSecret'>
	readonly reconcile: SchemaReconciler
	/** Admits the first administrator at IAM's `origin` with the provisioning key: `awsAdmitFirstAdministrator`. */
	readonly admit: (origin: string, provisioningKey: string, request: FirstAdministratorRequest) => Promise<FirstAdministratorResult>
	readonly signal: AbortSignal
	readonly log: (line: string) => void
	/** stdout, for the command's one piece of data: the enrollment URL, on a line of its own. */
	readonly print: (line: string) => void
}

/** Registers the console and IAM's vocabulary, then admits the first administrator and says exactly what it found. */
export async function runAwsAdmin(run: AwsAdminRun): Promise<FirstAdministratorResult> {
	const { options, signal, log } = run
	const caller = await run.sts.callerAccount(signal)
	if (caller !== options.accountId) {
		throw new Error(`aws: the credentials in the environment are account ${caller}'s, not account ${options.accountId}'s; export the named account's`)
	}
	const text = await run.secrets.readSecret(AWS_INSTALLATION_RECORD, signal)
	if (text === null) {
		throw new Error(`aws: account ${options.accountId}, ${options.region} holds no installation record; \`platform install\` makes one`)
	}
	const { plan } = parseAwsInstallationRecord(text)
	const provisioningKey = await awsProvisioningKey(run.secrets, signal)
	const origin = platformOrigin('https', plan.hosts.iam)
	log(`aws: ${origin} · ${options.email}`)
	await registerAwsPlatformApps({ plan, provisioningKey, reconcile: run.reconcile, signal, log })
	const result = await run.admit(origin, provisioningKey, { email: options.email, reissueEnrollment: options.reissue })
	log(
		result.principal === 'invited'
			? `aws: created principal ${result.principalId} for ${result.email}`
			: `aws: ${result.email} already exists as principal ${result.principalId}`,
	)
	log(result.grant === 'created' ? 'aws: granted the cross-app `admin` role' : 'aws: the cross-app `admin` role was already granted')
	const enrollment = result.enrollment
	if (enrollment.state === 'already-set') log('aws: a password is already set for this principal; no enrollment was issued')
	else if (enrollment.state === 'single-sign-on') log(`aws: this installation offers no password; sign in with single sign-on as ${result.email}`)
	else if (enrollment.state === 'outstanding') log(`aws: an enrollment is already outstanding and was not replaced; ${AWS_REISSUE_FLAG} replaces it`)
	else if (enrollment.state === 'emailed') log(`aws: the enrollment was emailed to ${enrollment.email}, valid until ${expiry(enrollment.expiresAt)}`)
	else {
		log('aws: nothing was emailed: this installation has no mail service. The URL below sets the first password; give it')
		log(`aws: to the administrator yourself. It is a credential: printed once, stored nowhere, valid until ${expiry(enrollment.expiresAt)}.`)
		run.print(enrollment.url)
	}
	return result
}

/** An enrollment's expiry (Unix seconds) as Zerops' `admin` states it. */
const expiry = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString()

/** The real admission: `installation-init`'s, through the installation's public IAM with the provisioning key. */
export const awsAdmitFirstAdministrator = (
	origin: string,
	provisioningKey: string,
	request: FirstAdministratorRequest,
): Promise<FirstAdministratorResult> => ensureFirstAdministrator(createIamAdminClient({ origin, provisioningKey }), request)
