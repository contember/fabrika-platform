// `fabrika platform admin --provider=zerops` — admit the first administrator to a running installation.
//
// `platform install` ends with a provisioning key and nobody who can sign in, and until this command
// existed the four `/admin/rpc` calls that fix that lived in a throwaway script. The mechanics are
// provider-neutral and live in `@fabrika/installation-init`; what belongs HERE is the Zerops-shaped
// half — where this installation's IAM answers, and which credential reaches it.
//
// It confirms nothing and prompts for nothing. Every step is additive and idempotent, so there is
// nothing for an operator to agree to, and `install`'s stdin rule (a non-terminal stdin is refused
// without `--yes`) has nothing to guard here.

import {
	action as consoleAction,
	createIamAdminClient,
	ensureFirstAdministrator,
	type FirstAdministratorApi,
	type FirstAdministratorResult,
} from '@fabrika/installation-init'
import type { PlatformAdminInput } from './admin-options'
import { REISSUE_FLAG } from './admin-options'
import { platformOrigin } from './hosts'
import { MACHINE_KEY_NEXT_STEP_TITLE, machineKeyNextStepLines } from './machine-key'

/**
 * Where this command's progress goes.
 *
 * The same rule the rest of this package's logging states: no helper here takes a secret value. The
 * enrollment URL is a credential in transit and never travels through the log — it goes to `print`,
 * which is stdout and nothing else.
 */
export interface AdminLog {
	step(title: string): void
	info(message: string): void
	warn(message: string): void
	ok(message: string): void
}

/** `AdminLog` plus the boxed hand-off the closing block uses — composed in below, not asked of the caller. */
export interface AdminReportLog extends AdminLog {
	action(title: string, lines: readonly string[]): void
}

export interface PlatformAdminCollaborators {
	readonly client: FirstAdministratorApi
	readonly log: AdminReportLog
	/** stdout, for the command's one piece of DATA: the enrollment URL, on a line of its own. */
	readonly print: (line: string) => void
}

/** The real collaborators: the typed admin client for this installation's public IAM, and the console. */
export const consoleAdminCollaborators = (input: PlatformAdminInput, log: AdminLog): PlatformAdminCollaborators => ({
	client: createIamAdminClient({ origin: platformOrigin(input.scheme, input.iamHost), provisioningKey: input.provisioningKey }),
	log: { ...log, action: (title, lines) => consoleAction(title, [...lines]) },
	print: (line) => console.info(line),
})

/**
 * Admit the first administrator, and report exactly what was found rather than what was assumed.
 *
 * Nothing is printed before the whole sequence has succeeded except its progress: a failure — an
 * unreachable IAM, a refused key, a 4xx — throws, and the CLI exits non-zero with that one message.
 * No partial result and, above all, no URL.
 */
export const runPlatformAdmin = async (input: PlatformAdminInput, collaborators: PlatformAdminCollaborators): Promise<void> => {
	const { client, log, print } = collaborators
	const origin = platformOrigin(input.scheme, input.iamHost)

	log.step('Admit the first administrator')
	log.info(`${origin} · ${input.email}`)
	if (input.scheme === 'http' && !isLoopback(input.iamHost)) {
		// Two credentials cross this connection: the provisioning key going out, the enrollment URL
		// coming back. On a loopback address that is a local composition; anywhere else it is a mistake.
		log.warn('this speaks plain http to a host that is not loopback — the provisioning key and the enrollment URL both cross it in the clear')
	}

	const result = await ensureFirstAdministrator(client, { email: input.email, reissueEnrollment: input.reissue })
	report(result, log)
	announceEnrollment(result, log, print)
	// The next command an operator runs needs an origin this one already holds and two keys it must not
	// print. Naming both places is the difference between one `key issue` and a guessed hostname.
	log.action(MACHINE_KEY_NEXT_STEP_TITLE, machineKeyNextStepLines({ iamOrigin: origin }))
}

const report = (result: FirstAdministratorResult, log: AdminLog): void => {
	log.ok(
		result.principal === 'invited'
			? `invited ${result.email} as principal ${result.principalId}`
			: `${result.email} already exists as principal ${result.principalId}`,
	)
	// `app: null` is the whole point: an `admin` grant scoped to the console's own app id leaves
	// Delivery and Operations working while the Access plane refuses.
	log.ok(result.grant === 'created' ? 'granted the cross-app `admin` role' : 'the cross-app `admin` role was already granted')
}

/**
 * The one place the enrollment URL is ever written, and it is written once.
 *
 * A URL that sets a password is a credential: it goes to stdout on a line of its own, is stored
 * nowhere, and is not repeated. The three other outcomes carry no URL at all and say what was found.
 */
const announceEnrollment = (result: FirstAdministratorResult, log: AdminLog, print: (line: string) => void): void => {
	if (result.enrollment.state === 'already-set') {
		log.ok('a password is already set for this principal — no enrollment was issued')
		log.info('Sign in at the console. A forgotten password is a reset, which the Access plane issues to a signed-in administrator.')
		return
	}
	if (result.enrollment.state === 'outstanding') {
		log.warn(`an enrollment is already outstanding — a second one was NOT issued. Pass ${REISSUE_FLAG} to replace it if the first expired unopened`)
		return
	}
	if (result.enrollment.state === 'emailed') {
		log.ok(`the enrollment was emailed to ${result.enrollment.email}, valid until ${expiry(result.enrollment.expiresAt)}`)
		return
	}
	log.ok(`enrollment issued, valid until ${expiry(result.enrollment.expiresAt)}`)
	log.info('The URL below sets the first password. It is a credential: it is printed once, stored nowhere, and it expires.')
	print(result.enrollment.url)
}

const expiry = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString()

/** Where `http` is a local composition rather than a credential crossing the open network. */
const isLoopback = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
