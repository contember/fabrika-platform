// A list's one search field, read the way GitHub reads its issue search: `qualifier:value` pairs separated by
// spaces, a value quoted when it holds a space. Each page declares its qualifiers (the filters its service can apply,
// and for a closed set the values it accepts) and whether the words without a qualifier are a text search. The
// field adds nothing the service cannot filter on: where there is no text search, a bare word is a mistake the field
// reports, not a search it pretends to run.

export interface Qualifier<K extends string> {
	key: K
	/** How the qualifier is written back into the field. */
	name: string
	/** Other spellings the field accepts. */
	aliases?: readonly string[]
	/** The accepted values, when the filter is a closed set. */
	values?: readonly string[]
}

export interface QueryLanguage<K extends string> {
	qualifiers: ReadonlyArray<Qualifier<K>>
	/** Whether words without a qualifier search the list's text. */
	freeText: boolean
}

export type QueryFilters<K extends string> = Partial<Record<K, string>>

export interface ParsedQuery<K extends string> {
	filters: QueryFilters<K>
	/** The words without a qualifier, joined by single spaces; always '' where there is no text search. */
	text: string
	/** What the field could not read, in order. */
	problems: string[]
}

export type QueryPartKind = 'qualifier' | 'value' | 'invalid' | 'text' | 'space'

function qualifierNamed<K extends string>(language: QueryLanguage<K>, name: string): Qualifier<K> | undefined {
	const lower = name.toLowerCase()
	return language.qualifiers.find((qualifier) => qualifier.name === lower || (qualifier.aliases ?? []).includes(lower))
}

const unquoted = (value: string): string => value.replaceAll('"', '')

/** The text cut into whole tokens and the runs of space between them, character for character. */
function segments(text: string): Array<{ text: string; space: boolean }> {
	const found: Array<{ text: string; space: boolean }> = []
	let index = 0
	while (index < text.length) {
		const start = index
		if (/\s/.test(text.charAt(index))) {
			while (index < text.length && /\s/.test(text.charAt(index))) index++
			found.push({ text: text.slice(start, index), space: true })
			continue
		}
		let quoted = false
		while (index < text.length && (quoted || !/\s/.test(text.charAt(index)))) {
			if (text.charAt(index) === '"') quoted = !quoted
			index++
		}
		found.push({ text: text.slice(start, index), space: false })
	}
	return found
}

type Reading<K extends string> =
	| { kind: 'filter'; qualifier: Qualifier<K>; name: string; value: string }
	| { kind: 'text'; value: string }
	| { kind: 'problem'; message: string; name?: string }

function read<K extends string>(language: QueryLanguage<K>, token: string): Reading<K> {
	const colon = token.indexOf(':')
	// A quoted token is always words, so a text search can hold what looks like a qualifier ("TypeError: x").
	if (colon <= 0 || token.startsWith('"')) {
		return language.freeText ? { kind: 'text', value: unquoted(token) } : { kind: 'problem', message: `"${unquoted(token)}" has no qualifier` }
	}
	const name = token.slice(0, colon)
	const value = unquoted(token.slice(colon + 1))
	const qualifier = qualifierNamed(language, name)
	// Where there is a text search, a colon that names no filter is part of the words (`TypeError:`, `host:5432`).
	if (qualifier === undefined && language.freeText) return { kind: 'text', value: unquoted(token) }
	if (qualifier === undefined) return { kind: 'problem', message: `"${name.toLowerCase()}:" is not a filter` }
	if (value === '') return { kind: 'problem', message: `"${name.toLowerCase()}:" needs a value`, name: token.slice(0, colon + 1) }
	if (qualifier.values !== undefined && !qualifier.values.includes(value)) {
		return { kind: 'problem', message: `"${qualifier.name}:" is one of ${qualifier.values.join(', ')}`, name: token.slice(0, colon + 1) }
	}
	return { kind: 'filter', qualifier, name: token.slice(0, colon + 1), value }
}

export function parseQuery<K extends string>(language: QueryLanguage<K>, text: string): ParsedQuery<K> {
	const filters: QueryFilters<K> = {}
	const words: string[] = []
	const problems: string[] = []
	for (const segment of segments(text)) {
		if (segment.space) continue
		const reading = read(language, segment.text)
		if (reading.kind === 'filter') filters[reading.qualifier.key] = reading.value
		else if (reading.kind === 'text') words.push(reading.value)
		else problems.push(reading.message)
	}
	return { filters, text: words.join(' '), problems }
}

/**
 * The text cut into coloured runs, character for character (quotes and spaces kept), so a layer drawn behind the
 * field lines up with what is typed. A qualifier still being typed (`app:` with no value yet) reads as a qualifier:
 * parsing reports it only when the search is applied.
 */
export function highlightQuery<K extends string>(language: QueryLanguage<K>, text: string): Array<{ text: string; kind: QueryPartKind }> {
	return segments(text).flatMap((segment): Array<{ text: string; kind: QueryPartKind }> => {
		if (segment.space) return [{ text: segment.text, kind: 'space' }]
		const reading = read(language, segment.text)
		if (reading.kind === 'filter') {
			return [{ text: reading.name, kind: 'qualifier' }, { text: segment.text.slice(reading.name.length), kind: 'value' }]
		}
		if (reading.kind === 'text') return [{ text: segment.text, kind: 'text' }]
		if (reading.name !== undefined && reading.name === segment.text) return [{ text: segment.text, kind: 'qualifier' }]
		if (reading.name !== undefined) {
			return [{ text: reading.name, kind: 'qualifier' }, { text: segment.text.slice(reading.name.length), kind: 'invalid' }]
		}
		return [{ text: segment.text, kind: 'invalid' }]
	})
}

/** The field's text for a set of filters, qualifiers in their declared order, then the text search. */
export function formatQuery<K extends string>(language: QueryLanguage<K>, filters: QueryFilters<K>, text = ''): string {
	const parts = language.qualifiers.flatMap(({ key, name }) => {
		const value = filters[key]
		if (value === undefined || value === '') return []
		return [`${name}:${/\s/.test(value) ? `"${value}"` : value}`]
	})
	// A word that reads as a qualifier, or holds a quote, goes back quoted, so the field reads it as words again.
	for (const word of text.split(/\s+/).filter((word) => word !== '')) parts.push(/[:"]/.test(word) ? `"${unquoted(word)}"` : word)
	return parts.join(' ')
}
