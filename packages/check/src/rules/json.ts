import type { Report } from '../finding'

const STRING_TOKEN = /"(?:[^"\\\n]|\\.)*"/g

const decode = (token: string): string | undefined => {
	try {
		const value: unknown = JSON.parse(token)
		return typeof value === 'string' ? value : undefined
	} catch {
		return undefined
	}
}

/** JSON can be imported as a module, so its strings fall under the same credential rule as source literals. */
export const checkJsonStrings = (text: string, report: Report): void => {
	for (const match of text.matchAll(STRING_TOKEN)) {
		if (!decode(match[0])?.includes('px_')) continue
		const before = text.slice(0, match.index)
		const line = before.split('\n').length
		const column = match.index - before.lastIndexOf('\n')
		report(
			{ line, column },
			'key-literal',
			`'px_' in a JSON string: a key or a session cookie name in source`,
			'the credential the framework supplies; keys never appear in files',
		)
	}
}
