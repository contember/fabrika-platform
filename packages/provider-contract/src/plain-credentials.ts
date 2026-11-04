// Whether a value about to sit somewhere readable looks like a credential.
//
// A plain variable is read by everyone who may read the configuration it lives in: on Zerops every member of the
// project, on Control everyone who manages the application. A credential belongs where nobody reads it back (a
// sensitive service variable, an application secret). The check is a heuristic over the NAME and the VALUE, and it
// errs towards refusing, so each place that runs it has an explicit opt-out for a value it got wrong.
//
// Nothing here returns, logs or embeds the value: a finding names only why it matched.

/** Why a name and value look like a credential. `because` completes "… looks like a credential: <because>". */
export interface PlainCredentialFinding {
	readonly basis: 'name' | 'value'
	readonly because: string
}

/** Words in a variable name that mark a credential on their own; `BASIC` followed by `AUTH` does too. */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
	'TOKEN',
	'SECRET',
	'PASSWORD',
	'PASSWD',
	'PASSPHRASE',
	'PWD',
	'CREDENTIAL',
	'CREDENTIALS',
	'APIKEY',
	'PRIVATEKEY',
	'BASICAUTH',
	'HTPASSWD',
])

/** Words that make `KEY` something other than a credential: `KEY_ID`, `PUBLIC_KEY`, `SITE_KEY`, `CACHE_KEY`. */
const NON_CREDENTIAL_KEY_WORDS: ReadonlySet<string> = new Set([
	'ID',
	'IDS',
	'PUBLIC',
	'PUBLISHABLE',
	'SITE',
	'CACHE',
	'PARTITION',
	'SORT',
	'PRIMARY',
	'FOREIGN',
])

/**
 * A last word that makes the name describe a credential rather than hold one: `TOKEN_URL`, `PASSWORD_MIN_LENGTH`,
 * `SECRET_NAME`, `API_KEY_HEADER`.
 */
const DESCRIPTOR_WORDS: ReadonlySet<string> = new Set([
	'URL',
	'URI',
	'ENDPOINT',
	'HOST',
	'ORIGIN',
	'PATH',
	'FILE',
	'DIR',
	'ID',
	'IDS',
	'NAME',
	'NAMES',
	'HEADER',
	'PARAM',
	'TTL',
	'LIFETIME',
	'EXPIRY',
	'EXPIRES',
	'LENGTH',
	'SIZE',
	'ALGORITHM',
	'ISSUER',
	'AUDIENCE',
	'MODE',
	'ENABLED',
	'REQUIRED',
	'PREFIX',
	'POLICY',
	'TYPE',
	'VERSION',
	'COUNT',
	'LIMIT',
	'TIMEOUT',
	'REALM',
])

/** `FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN`, `apiKey`, `basic-auth.password` → upper-case words. */
const nameWords = (name: string): readonly string[] =>
	name
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.toUpperCase()
		.split(/[^A-Z0-9]+/)
		.filter((word) => word !== '')

/** The word of a credential name that matched, or null. */
const credentialWordIn = (name: string): string | null => {
	const words = nameWords(name)
	const last = words.at(-1)
	if (last === undefined || DESCRIPTOR_WORDS.has(last)) return null
	for (const [index, word] of words.entries()) {
		if (CREDENTIAL_WORDS.has(word)) return word
		if (word === 'BASIC' && words[index + 1] === 'AUTH') return 'BASIC_AUTH'
		if (word === 'KEY') {
			const before = words[index - 1]
			const after = words[index + 1]
			if (before !== undefined && NON_CREDENTIAL_KEY_WORDS.has(before)) continue
			if (after !== undefined && NON_CREDENTIAL_KEY_WORDS.has(after)) continue
			return word
		}
	}
	return null
}

/**
 * A Zerops or shell reference (`${db_password}`) names a value held elsewhere, so it is not one here. Removing them
 * leaves the literal part of a value; a value that is only references holds no literal at all.
 */
const withoutReferences = (value: string): string => value.replace(/\$\{[^}]*\}/g, '')

/** Prefixes that issuers put on their tokens. */
const TOKEN_PREFIXES: readonly (readonly [RegExp, string])[] = [
	[/^px_[A-Za-z0-9_-]{8,}/, 'a Fabrika key'],
	[/^(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/, 'a GitHub token'],
	[/^github_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
	[/^glpat-[A-Za-z0-9_-]{16,}/, 'a GitLab token'],
	[/^(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/, 'a Stripe key'],
	[/^whsec_[A-Za-z0-9+/=]{16,}/, 'a webhook signing secret'],
	[/^xox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
	[/^sk-[A-Za-z0-9_-]{20,}/, 'an API secret key'],
	[/^AKIA[0-9A-Z]{16}$/, 'an AWS access key'],
	[/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'a signed JSON Web Token'],
]

/** Shannon entropy in bits per character. */
const entropy = (text: string): number => {
	const counts = new Map<string, number>()
	for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1)
	let bits = 0
	for (const count of counts.values()) {
		const share = count / text.length
		bits -= share * Math.log2(share)
	}
	return bits
}

/** The share of `text` that matches `pattern`, a single-character class. */
const share = (text: string, pattern: RegExp): number => (text.match(pattern)?.length ?? 0) / text.length

/**
 * A random-looking single word: at least 24 characters of a token alphabet, at least a fifth of them upper case and a
 * fifth lower case, and at least 4 bits of entropy per character. A camel-case name has far fewer capitals than a
 * random string. Hexadecimal (a digest, a UUID) has one letter case and at most 4 bits, so it never matches: a hex
 * credential is caught by its name or not at all.
 */
const looksRandom = (text: string): boolean =>
	text.length >= 24
	&& /^[A-Za-z0-9+/=_-]+$/.test(text)
	&& share(text, /[A-Z]/g) >= 0.2
	&& share(text, /[a-z]/g) >= 0.2
	&& entropy(text) >= 4

/** What the VALUE alone says, or null. Never echoes it. */
const valueFinding = (value: string): string | null => {
	const literal = withoutReferences(value).trim()
	if (literal === '') return null
	if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(literal)) return 'it holds a private key'
	if (/^(Basic|Bearer|Token)\s+\S{8,}$/i.test(literal)) return 'it is an Authorization header value'
	// `scheme://user:password@host`: a password in the URL's userinfo. A reference in the password was removed above.
	if (/^[a-z][a-z0-9+.-]*:\/\/[^/@:\s]*:[^/@\s]+@/i.test(literal)) return 'its URL carries a password'
	for (const [pattern, kind] of TOKEN_PREFIXES) {
		if (pattern.test(literal)) return `it reads like ${kind}`
	}
	if (looksRandom(literal)) return 'it is a long random string'
	return null
}

/**
 * Whether a plain `name = value` looks like a credential, and why; null when it does not.
 *
 * The name matches on a credential word (`TOKEN`, `SECRET`, `PASSWORD`, `BASIC_AUTH`, a `KEY` that is not an id, a
 * public key or a cache key), unless its last word makes it describe one (`TOKEN_URL`, `PASSWORD_MIN_LENGTH`). A name match needs a
 * literal value: an empty value or one made only of references holds no credential. The value matches on its own: a
 * private key, an Authorization header, a URL with a password, an issuer's token prefix, or a long random string.
 */
export function plainCredentialFinding(name: string, value: string): PlainCredentialFinding | null {
	const word = credentialWordIn(name)
	if (word !== null && withoutReferences(value).trim() !== '') {
		return { basis: 'name', because: `its name contains \`${word}\`` }
	}
	const because = valueFinding(value)
	return because === null ? null : { basis: 'value', because }
}
