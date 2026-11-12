// IAM's human authentication methods as both installers take them: `--auth-methods`, or the pair of switches beside
// it, and the OIDC client's coordinates. What a provider writes for them, and what it defaults to when the operator
// names none, is the provider's own.

import { type CommandEnv, readEnv, readFlag } from './options'

export const AUTH_METHODS_FLAG = '--auth-methods'
export const OIDC_ISSUER_FLAG = '--oidc-issuer'
export const OIDC_CLIENT_ID_FLAG = '--oidc-client-id'

/** The installer's input names. IAM's own names differ per runtime; the provider maps them. */
export const OIDC_ISSUER_INPUT = 'FABRIKA_IAM_OIDC_ISSUER'
export const OIDC_CLIENT_ID_INPUT = 'FABRIKA_IAM_OIDC_CLIENT_ID'
/** A credential: environment only, and no flag. */
export const OIDC_CLIENT_SECRET_INPUT = 'FABRIKA_IAM_OIDC_CLIENT_SECRET'

const OIDC_ENABLED_VARIABLE = 'FABRIKA_IAM_OIDC_ENABLED'
const PASSWORD_ENABLED_VARIABLE = 'FABRIKA_IAM_PASSWORD_ENABLED'

const AUTH_METHODS = ['oidc', 'password'] as const

/** At least one method: IAM refuses to boot with neither, so neither is not a value. */
export type AuthMethods =
	| { readonly oidcEnabled: true; readonly passwordEnabled: boolean }
	| { readonly oidcEnabled: false; readonly passwordEnabled: true }

/** The OIDC client IAM signs people in with. */
export interface OidcClient {
	readonly issuer: string
	readonly clientId: string
	/** Never logged, never printed. */
	readonly clientSecret: string
}

const authMethods = (oidcEnabled: boolean, passwordEnabled: boolean): AuthMethods => {
	if (oidcEnabled) return { oidcEnabled: true, passwordEnabled }
	if (passwordEnabled) return { oidcEnabled: false, passwordEnabled: true }
	throw new Error('At least one IAM authentication method must be enabled')
}

const parseBoolean = (value: string, name: string): boolean => {
	if (value === 'true') return true
	if (value === 'false') return false
	throw new Error(`${name} must be true or false`)
}

/**
 * `--auth-methods`, or the pair of switches the environment carries.
 *
 * With neither, `fallback` when the provider has one, and an error naming both ways in when it has none.
 */
export const readAuthMethods = (argv: readonly string[], env: CommandEnv, fallback?: AuthMethods): AuthMethods => {
	const flag = readFlag(argv, AUTH_METHODS_FLAG)
	if (flag !== undefined) {
		const methods = flag.split(',').map((item) => item.trim())
		const unknown = methods.find((method) => !AUTH_METHODS.some((known) => known === method))
		if (unknown !== undefined || methods.length > AUTH_METHODS.length) {
			throw new Error(`${AUTH_METHODS_FLAG} takes oidc, password, or oidc,password, not \`${flag}\``)
		}
		return authMethods(methods.includes('oidc'), methods.includes('password'))
	}
	const oidc = readEnv(env, OIDC_ENABLED_VARIABLE)
	const password = readEnv(env, PASSWORD_ENABLED_VARIABLE)
	if (oidc === undefined && password === undefined) {
		if (fallback !== undefined) return fallback
		throw new Error(
			`${AUTH_METHODS_FLAG}=<oidc|password|oidc,password> or ${OIDC_ENABLED_VARIABLE} + ${PASSWORD_ENABLED_VARIABLE} is required`,
		)
	}
	if (oidc === undefined || password === undefined) {
		throw new Error(`${OIDC_ENABLED_VARIABLE} and ${PASSWORD_ENABLED_VARIABLE} must be configured together`)
	}
	return authMethods(parseBoolean(oidc, OIDC_ENABLED_VARIABLE), parseBoolean(password, PASSWORD_ENABLED_VARIABLE))
}

/** An issuer IAM can discover `/.well-known/openid-configuration` under. The value is a public URL, so it is quoted. */
export const checkedOidcIssuer = (issuer: string): string => {
	if (!URL.canParse(issuer)) {
		throw new Error(`${OIDC_ISSUER_FLAG} / ${OIDC_ISSUER_INPUT} is not a URL: \`${issuer}\``)
	}
	return issuer
}

/** A flag that only means something under a selection the run did not make is refused, not ignored. */
export const refuseFlags = (argv: readonly string[], flags: readonly string[], why: string): void => {
	const given = flags.find((flag) => readFlag(argv, flag) !== undefined)
	if (given !== undefined) {
		throw new Error(`${given} was given, but ${why}`)
	}
}
