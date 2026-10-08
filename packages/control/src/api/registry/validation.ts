import { FABRIKA_IAM_ISSUER } from '@fabrika/auth-core'
import { operationsManagedEnvironmentCollisions } from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE } from '@fabrika/operations-contract/releases'
import { isProxyHost } from '@fabrika/proxy-core/manifest'
import { canonicalPublicOrigin, PublicOriginValidationError } from '../../public-origin'
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

/** Refuse a name the platform assigns itself, whichever surface writes it (ADR-0035). */
export function assertUnmanagedName(kind: 'variable' | 'secret', name: string): void {
	if (name === FABRIKA_RELEASE || name === FABRIKA_IAM_ISSUER || operationsManagedEnvironmentCollisions([name]).length > 0) {
		fail(400, `application ${kind} "${name}" is managed by Fabrika`)
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
