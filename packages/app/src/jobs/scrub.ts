// What an error report must not carry (ADR-0059): the values of the application's secrets, and anything shaped like a
// credential — a JWT, an `Authorization` scheme or header, a URL's userinfo, a sensitive query parameter.

import {
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	FABRIKA_OPS_KEY_DIGESTS,
	PLATFORM_RECEIVERS,
	platformTransportVariables,
} from '@fabrika/auth-core'
import type { CapturedEnvironment } from '../implement/environment'

export const REDACTED = '[redacted]'

/** A shorter value is no credential the platform generates, and scrubbing it would mangle ordinary text. */
export const MIN_SECRET_LENGTH = 8

/** The framework variables that are public by design; every other `FABRIKA_*` value is treated as a secret. */
const PUBLIC_FRAMEWORK_VARIABLES: ReadonlySet<string> = new Set([
	'FABRIKA_RELEASE',
	'FABRIKA_APP_ID',
	'FABRIKA_ENVIRONMENT',
	'FABRIKA_IAM_RPC_URL',
	'FABRIKA_APP_DATABASE_CONNECTIONS',
	// `platform` is eight characters, so a secret scrubber would redact the word wherever a message names it.
	'FABRIKA_EMAIL_PROVIDER',
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	// Digests of the ops keys, which are no credential; the object names are words (`application`) a message carries.
	FABRIKA_OPS_KEY_DIGESTS,
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	...PLATFORM_RECEIVERS.map((receiver) => platformTransportVariables(receiver).url),
])

/**
 * An application variable whose name says it holds a secret. The runtime does not know which names the application
 * declared as secrets, so the name decides (backlog 176).
 */
const SECRET_NAME = /secret|token|passw|private|credential|key|auth|dsn|salt|connection|cookie|session|signature|cert/i

const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
const AUTHORIZATION_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const CREDENTIAL_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie|x-fabrika-token|x-api-key)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi
const SENSITIVE_QUERY_PARAMETER = /([?&][^=&#\s]*(?:token|key|secret|passw|signature|sig|auth|code|session|credential)[^=&#\s]*=)[^&#\s"'<>]*/gi

export interface Scrubber {
	scrub(text: string): string
}

function urlCredentials(value: string): string[] {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return []
	}
	return [url.username, url.password].flatMap((part) => {
		const decoded = safeDecode(part)
		return decoded === part ? [part] : [part, decoded]
	})
}

function safeDecode(part: string): string {
	try {
		return decodeURIComponent(part)
	} catch {
		return part
	}
}

/** Every value of `environment` that is a secret, with the user and password of a URL-shaped one. */
export function secretValues(environment: CapturedEnvironment): string[] {
	const values: string[] = []
	for (const [name, value] of Object.entries(environment.framework)) {
		if (!PUBLIC_FRAMEWORK_VARIABLES.has(name)) {
			values.push(value, ...urlCredentials(value))
		}
	}
	for (const [name, value] of Object.entries(environment.application)) {
		if (typeof value === 'string' && SECRET_NAME.test(name)) {
			values.push(value, ...urlCredentials(value))
		}
	}
	const kept = values.map((value) => value.trim()).filter((value) => value.length >= MIN_SECRET_LENGTH)
	// The longest first, so a value that contains another is replaced whole.
	return [...new Set(kept)].sort((a, b) => b.length - a.length)
}

export function secretScrubber(secrets: readonly string[]): Scrubber {
	return {
		scrub(text) {
			let scrubbed = text
			for (const secret of secrets) {
				scrubbed = scrubbed.replaceAll(secret, REDACTED)
			}
			return scrubbed
				.replace(JWT, REDACTED)
				.replace(AUTHORIZATION_SCHEME, `$1 ${REDACTED}`)
				.replace(CREDENTIAL_HEADER, `$1$2${REDACTED}`)
				.replace(URL_USERINFO, `$1${REDACTED}@`)
				.replace(SENSITIVE_QUERY_PARAMETER, `$1${REDACTED}`)
		},
	}
}

/** The scrubber of one application environment: its secrets' values, then the credential patterns. */
export function environmentScrubber(environment: CapturedEnvironment): Scrubber {
	return secretScrubber(secretValues(environment))
}
