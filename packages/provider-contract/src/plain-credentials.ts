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
	'PASS',
	'PASSPHRASE',
	'PWD',
	'CREDENTIAL',
	'CREDENTIALS',
	'APIKEY',
	'PRIVATEKEY',
	'BASICAUTH',
	'HTPASSWD',
])

/** Words that make `KEY` (or `KEYS`) something other than a credential: `KEY_ID`, `PUBLIC_KEY`, `SITE_KEY`, `CACHE_KEY`. */
// Not `PRIMARY`: some providers call a secret a primary key (an account's primary access key).
const NON_CREDENTIAL_KEY_WORDS: ReadonlySet<string> = new Set([
	'ID',
	'IDS',
	'PUBLIC',
	'PUBLISHABLE',
	'SITE',
	'CACHE',
	'PARTITION',
	'SORT',
	'FOREIGN',
])

/** The words beside `KEY` that make its value public, not merely not a credential. */
const PUBLIC_KEY_WORDS: ReadonlySet<string> = new Set(['PUBLIC', 'PUBLISHABLE', 'SITE'])

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

/** Whether the `KEY` at `index` is an id, a public key or a cache key: a word beside it says so. */
const nonCredentialKey = (words: readonly string[], index: number): boolean => {
	const before = words[index - 1]
	const after = words[index + 1]
	return (before !== undefined && NON_CREDENTIAL_KEY_WORDS.has(before)) || (after !== undefined && NON_CREDENTIAL_KEY_WORDS.has(after))
}

/** The word of a credential name that matched, or null. */
const credentialWordIn = (words: readonly string[]): string | null => {
	const last = words.at(-1)
	if (last === undefined || DESCRIPTOR_WORDS.has(last)) return null
	for (const [index, word] of words.entries()) {
		if (CREDENTIAL_WORDS.has(word)) return word
		if (word === 'BASIC' && words[index + 1] === 'AUTH') return 'BASIC_AUTH'
		if ((word === 'KEY' || word === 'KEYS') && !nonCredentialKey(words, index)) return word
	}
	return null
}

/**
 * Whether the name says its value is public: a publishable, site or public key, or an id, in a name with no credential
 * word. Such a value is often long and random (`pk_live_…`, a reCAPTCHA site key, a VAPID public key), so the
 * random-string rule does not apply to it. A name that also says `SECRET` (`SECRET_KEY_ID`) is not public.
 */
const namesAPublicValue = (words: readonly string[]): boolean => {
	if (words.some((word, index) => CREDENTIAL_WORDS.has(word) || (word === 'BASIC' && words[index + 1] === 'AUTH'))) return false
	const publicKey = words.some((word, index) =>
		(word === 'KEY' || word === 'KEYS')
		&& [words[index - 1], words[index + 1]].some((beside) => beside !== undefined && PUBLIC_KEY_WORDS.has(beside))
	)
	return publicKey || words.at(-1) === 'ID' || words.at(-1) === 'IDS'
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

/**
 * The literal part of a value: references removed, and an Authorization scheme left standing alone by that removal
 * (`Bearer ${token}`) dropped with them.
 */
const literalOf = (value: string): string => withoutReferences(value).trim().replace(/^(Basic|Bearer|Token)$/i, '')

/**
 * A setting's value, unwrapped from how a response header is written in `zerops.yaml` (`"'true' always"`): surrounding
 * quotes and nginx's trailing `always` removed.
 */
const settingOf = (literal: string): string => {
	let text = literal.replace(/\s+always$/i, '').trim()
	for (let round = 0; round < 2; round++) text = text.replace(/^(['"])(.*)\1$/, '$2').trim()
	return text
}

/** A boolean is never a credential, whatever the name says (`Access-Control-Allow-Credentials: true`). */
const isBoolean = (setting: string): boolean => /^(true|false|yes|no|on|off)$/i.test(setting)

/**
 * A short integer, a decimal or a duration: what a setting that only describes a credential holds (`TOKEN_EXPIRES_IN`,
 * `KEY_ROTATION_DAYS`). It counts only when a word after the credential word names a quantity: `DB_PASSWORD=1234` and
 * `DB_PASSWORD_PROD=1234` are a PIN, and an integer of six digits or more counts anywhere.
 */
const isQuantity = (setting: string): boolean => /^(\d{1,5}|\d+\.\d+|\d+(ms|s|m|h|d))$/i.test(setting)

/** Words that make a name after its credential word a quantity: `TOKEN_EXPIRES_IN`, `KEY_ROTATION_DAYS`, `PASS_RATE`. */
const QUANTITY_WORDS: ReadonlySet<string> = new Set([
	'EXPIRES',
	'EXPIRY',
	'IN',
	'AGE',
	'LIFE',
	'LIFETIME',
	'TTL',
	'ROTATION',
	'DAYS',
	'HOURS',
	'MINUTES',
	'SECONDS',
	'INTERVAL',
	'PERIOD',
	'WINDOW',
	'RATE',
	'THRESHOLD',
	'RATIO',
	'MIN',
	'MAX',
	'LENGTH',
	'SIZE',
	'COUNT',
	'LIMIT',
	'RETRIES',
	'ATTEMPTS',
	'TIMEOUT',
])

/** Whether a word after the credential word that matched names a quantity. */
const describesAQuantity = (words: readonly string[], word: string): boolean => {
	const at = words.indexOf(word === 'BASIC_AUTH' ? 'AUTH' : word)
	return at !== -1 && words.slice(at + 1).some((after) => QUANTITY_WORDS.has(after))
}

/** What the VALUE alone says, or null. Never echoes it. */
const valueFinding = (literal: string, publicValue: boolean): string | null => {
	if (literal === '') return null
	if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(literal)) return 'it holds a private key'
	if (/^(Basic|Bearer|Token)\s+\S{8,}$/i.test(literal)) return 'it is an Authorization header value'
	// `scheme://user:password@host`: a password in the URL's userinfo. A reference in the password was removed above.
	if (/^[a-z][a-z0-9+.-]*:\/\/[^/@:\s]*:[^/@\s]+@/i.test(literal)) return 'its URL carries a password'
	for (const [pattern, kind] of TOKEN_PREFIXES) {
		if (pattern.test(literal)) return `it reads like ${kind}`
	}
	if (!publicValue && looksRandom(literal)) return 'it is a long random string'
	return null
}

/**
 * Whether a plain `name = value` looks like a credential, and why; null when it does not.
 *
 * The name matches on a credential word (`TOKEN`, `SECRET`, `PASSWORD`, `PASS`, `BASIC_AUTH`, a `KEY` or `KEYS` that is
 * not an id, a public key or a cache key), unless its last word makes it describe one (`TOKEN_URL`,
 * `PASSWORD_MIN_LENGTH`). A name match needs a literal that could be a credential: an empty value, one made only of
 * references or a boolean is not, nor a short number or duration under a name that says it is a quantity. The value matches on its own: a private key, an
 * Authorization header, a URL with a password, an issuer's token prefix, or a long random string unless the name says
 * the value is public (a publishable or site key, an id).
 */
export function plainCredentialFinding(name: string, value: string): PlainCredentialFinding | null {
	const words = nameWords(name)
	const literal = literalOf(value)
	const word = credentialWordIn(words)
	const setting = settingOf(literal)
	const describes = isBoolean(setting) || (word !== null && isQuantity(setting) && describesAQuantity(words, word))
	if (word !== null && literal !== '' && !describes) {
		return { basis: 'name', because: `its name contains \`${word}\`` }
	}
	const because = valueFinding(literal, namesAPublicValue(words))
	return because === null ? null : { basis: 'value', because }
}
