// `platform deploy` refuses an installation whose platform services hold a credential as a READABLE variable.
//
// A readable service variable is read by every member of the Zerops project, and Zerops keeps no record of who read it.
// Nothing Fabrika writes is one: `install` writes the generated secrets and the mail credentials sensitive, and the
// deploy writes only configuration readable. But the guide's own procedures (setting or rotating the mail transport)
// are manual writes in the Zerops GUI or `zcli`, where `sensitive` is a checkbox. An installation was found holding its
// mail provider's token readable on `iam` and `control`, written that way. The deploy reads every service's environment
// anyway, and every upgrade runs it, so it is where such a variable is caught.
//
// The check is `plainCredentialFinding`'s heuristic plus the mail providers' own declarations, and it errs towards
// refusing, so `FABRIKA_PLATFORM_PLAIN_VARIABLES` names the variables an operator has checked are not credentials.

import { builtinEmailProviders } from '@fabrika/email/providers'
import { plainCredentialFinding } from '@fabrika/provider-contract'
import type { LiveServiceEnv, PlatformDeployService } from './deploy'

/** One readable variable that looks like a credential. Names only; the value is never carried. */
export interface PlainCredentialVariable {
	readonly service: PlatformDeployService
	readonly key: string
	readonly because: string
}

/** Every mail provider variable the provider itself declares secret, whichever provider an installation uses. */
const DECLARED_SECRET_EMAIL_VARIABLES: ReadonlySet<string> = new Set(
	Object.values(builtinEmailProviders).flatMap((provider) =>
		provider.variables.filter((variable) => variable.secret).map((variable) => variable.name)
	),
)

/** `<service>/<KEY>`, the form an operator names an exception in. */
export const plainVariableId = (service: string, key: string): string => `${service}/${key}`

/**
 * The readable variables of one service that look like credentials.
 *
 * `written` are the keys this deploy writes itself, readable by design and about to be overwritten: they are its own
 * configuration, never a credential. `allowed` are the `<service>/<KEY>` exceptions the operator named.
 */
export const plainCredentialVariables = (
	service: PlatformDeployService,
	live: LiveServiceEnv,
	written: ReadonlySet<string>,
	allowed: ReadonlySet<string>,
): PlainCredentialVariable[] => {
	const found: PlainCredentialVariable[] = []
	for (const [key, record] of live) {
		// A record the platform owns (`type: SYSTEM`) is not the operator's to make sensitive, so it is not refused.
		if (record.sensitive || record.type === 'SYSTEM' || written.has(key) || allowed.has(plainVariableId(service, key))) continue
		if (DECLARED_SECRET_EMAIL_VARIABLES.has(key) && record.content.trim() !== '') {
			found.push({ service, key, because: 'its mail provider declares it secret' })
			continue
		}
		const finding = plainCredentialFinding(key, record.content)
		if (finding !== null) found.push({ service, key, because: finding.because })
	}
	return found
}

/** The refusal: each variable by name and reason, where it belongs instead, and the opt-out. Never a value. */
export const plainCredentialRefusal = (found: readonly PlainCredentialVariable[]): Error =>
	new Error(
		[
			`${found.length} readable service variable(s) look like credentials, and every member of the Zerops project can read them:`,
			...found.map((entry) => `  ${plainVariableId(entry.service, entry.key)}: ${entry.because}`),
			'Store each one as a SENSITIVE variable of the same service, then restart that service: in the Zerops GUI, delete',
			'the variable and add it again as a secret one. `zops env set --sensitive` does not change an existing variable.',
			'Nothing has been written or deployed.',
			'A variable that is not a credential: name it in FABRIKA_PLATFORM_PLAIN_VARIABLES (or --plain-variables) as',
			'`<service>/<KEY>`, comma-separated, and deploy again.',
		].join('\n'),
	)

/** Parse the operator's exceptions: comma-separated `<service>/<KEY>`, each naming a platform service. */
export const parsePlainVariables = (raw: string | undefined, services: readonly string[]): ReadonlySet<string> => {
	const allowed = new Set<string>()
	if (raw === undefined) return allowed
	for (const [index, entry] of raw.split(',').map((item) => item.trim()).filter((item) => item !== '').entries()) {
		const slash = entry.indexOf('/')
		const service = slash === -1 ? '' : entry.slice(0, slash)
		const key = slash === -1 ? '' : entry.slice(slash + 1)
		if (!services.includes(service) || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
			throw new Error(
				// The entry is not echoed: a value pasted there by mistake would land in a CI log.
				`--plain-variables / FABRIKA_PLATFORM_PLAIN_VARIABLES: entry ${index + 1} is not \`<service>/<KEY>\` with a service of ${services.join(', ')}`,
			)
		}
		allowed.add(plainVariableId(service, key))
	}
	return allowed
}
