import { APP_ENVIRONMENT_SEPARATOR, frameworkVariableReference, isAppEnvironmentPart, isFrameworkVariableName } from '@fabrika/auth-core'
import { isProxyHost } from '@fabrika/proxy-core/manifest'
import { canonicalPublicOrigin, PublicOriginValidationError } from '../../public-origin'
import { canonicalTriggerRef, TriggerRefValidationError } from '../../ref-match'
import { fail } from '../domain'

/** The longest a variable value may be; it is spliced into provider configuration, not stored opaquely. */
export const APP_VAR_VALUE_MAX_LENGTH = 4096

/**
 * Every C0 control except tab, plus DEL and the C1 block — anything that could close or reopen a config
 * token. NEL (U+0085), LS (U+2028) and PS (U+2029) are here because a YAML 1.1 reader ends a line on them
 * even though JavaScript does not, so "one line" has to mean one line to that reader too.
 */
const isControlCharacter = (code: number): boolean =>
	(code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029

/** Refuse a name the platform assigns itself, whichever surface writes it (ADR-0035, ADR-0043). */
export function assertUnmanagedName(kind: 'variable' | 'secret', name: string): void {
	if (isFrameworkVariableName(name)) {
		fail(400, `application ${kind} "${name}" is managed by Fabrika`)
	}
}

/** Refuse a value that would copy a platform-owned variable into one the application controls (`${RUNTIME_FABRIKA_…}`). */
export function assertNoFrameworkReference(kind: 'variable' | 'secret', value: string): void {
	const reference = frameworkVariableReference(value)
	if (reference !== null) {
		fail(400, `application ${kind} value references the Fabrika-managed variable \`${reference}\``)
	}
}

/** `@` joins an app id and an environment into the IAM application id `<app>@<env>` (ADR-0022 rule 6), so neither may hold it. */
export function assertAppEnvironmentPart(kind: 'app id' | 'environment', value: string): void {
	if (!isAppEnvironmentPart(value)) {
		fail(400, `${kind} "${value}" must be non-empty and must not contain '${APP_ENVIRONMENT_SEPARATOR}'`)
	}
}

/** Keep a variable value one bounded line: the Zerops import document interpolates it as raw text. */
export function assertAppVarValue(value: string): void {
	if (value.length > APP_VAR_VALUE_MAX_LENGTH) {
		fail(400, `application variable value must be at most ${APP_VAR_VALUE_MAX_LENGTH} characters`)
	}
	if ([...value].some((character) => isControlCharacter(character.codePointAt(0) ?? 0))) {
		fail(400, 'application variable value must be a single line (no line breaks or control characters)')
	}
}

/** The proxy routes on a literal host, so an operator learns here rather than from a failed proxy build. */
export function assertProxyDomain(domain: string | null | undefined): void {
	if (domain === undefined || domain === null) return
	if (!isProxyHost(domain.toLowerCase())) {
		fail(400, `domain "${domain}" must be a literal hostname — no wildcard, port, path, or placeholder`)
	}
}

/** A requested trigger ref in its stored form (`canonicalTriggerRef`); null keeps the environment manual-only. */
export function triggerRefInput(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null
	try {
		return canonicalTriggerRef(value)
	} catch (cause) {
		if (cause instanceof TriggerRefValidationError) fail(400, cause.message)
		throw cause
	}
}

export function canonicalOrigin(value: string | null | undefined, fallback: string | null): string | null {
	if (value === undefined) return fallback
	if (value === null) return null
	try {
		return canonicalPublicOrigin(value)
	} catch (cause) {
		if (cause instanceof PublicOriginValidationError) fail(400, cause.message)
		throw cause
	}
}
