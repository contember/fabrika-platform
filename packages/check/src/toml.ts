// The subset of TOML a `bunfig.toml` is read in, decoded the way Bun decodes it, so a quoted or dotted key is the same
// key as its bare form. Plain JavaScript: the reader runs it in a Worker, where `Bun.TOML` does not exist. A file
// outside the subset is not guessed at; the caller refuses it.

export type TomlValue =
	| { readonly kind: 'string'; readonly value: string }
	| { readonly kind: 'array'; readonly items: readonly TomlValue[] }
	/** A number, boolean or date, kept as its source text. */
	| { readonly kind: 'scalar'; readonly raw: string }

export interface TomlEntry {
	/** The full key: the table's key followed by the entry's own, each decoded. */
	readonly key: readonly string[]
	readonly value: TomlValue
	readonly line: number
}

export type TomlDocument =
	| { readonly ok: true; readonly entries: readonly TomlEntry[] }
	| { readonly ok: false; readonly line: number; readonly message: string }

class Unsupported extends Error {}

const BARE_KEY = /^[A-Za-z0-9_-]+/
const SCALAR = /^[A-Za-z0-9_.:+-]+/
const ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

/** A cursor over one line. */
class Line {
	index = 0
	constructor(readonly text: string) {}

	skipSpace(): void {
		while (this.text[this.index] === ' ' || this.text[this.index] === '\t') this.index++
	}

	/** True at the end of the line or at a comment. */
	atEnd(): boolean {
		this.skipSpace()
		return this.index >= this.text.length || this.text[this.index] === '#'
	}

	expect(char: string): void {
		this.skipSpace()
		if (this.text[this.index] !== char) throw new Unsupported(`expected '${char}'`)
		this.index++
	}

	rest(): string {
		return this.text.slice(this.index)
	}

	string(): string {
		const quote = this.text[this.index]
		if (this.text.startsWith(quote === '"' ? '"""' : "'''", this.index)) throw new Unsupported('a multi-line string')
		this.index++
		let value = ''
		while (this.index < this.text.length) {
			const char = this.text[this.index] ?? ''
			this.index++
			if (char === quote) return value
			if (quote === '"' && char === '\\') value += this.escape()
			else value += char
		}
		throw new Unsupported('an unterminated string')
	}

	private escape(): string {
		const code = this.text[this.index] ?? ''
		this.index++
		const simple = ESCAPES[code]
		if (simple !== undefined) return simple
		const length = code === 'u' ? 4 : code === 'U' ? 8 : 0
		const hex = this.text.slice(this.index, this.index + length)
		if (length === 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== length) throw new Unsupported('an unknown escape')
		this.index += length
		return String.fromCodePoint(Number.parseInt(hex, 16))
	}

	key(): string[] {
		const parts: string[] = []
		for (;;) {
			this.skipSpace()
			const char = this.text[this.index]
			if (char === '"' || char === "'") {
				parts.push(this.string())
			} else {
				const bare = BARE_KEY.exec(this.rest())?.[0]
				if (bare === undefined) throw new Unsupported('a key that is neither bare nor quoted')
				parts.push(bare)
				this.index += bare.length
			}
			this.skipSpace()
			if (this.text[this.index] !== '.') return parts
			this.index++
		}
	}

	value(): TomlValue {
		this.skipSpace()
		const char = this.text[this.index]
		if (char === '"' || char === "'") return { kind: 'string', value: this.string() }
		if (char === '[') return this.array()
		if (char === '{') throw new Unsupported('an inline table')
		const raw = SCALAR.exec(this.rest())?.[0]
		if (raw === undefined) throw new Unsupported('a value outside strings, arrays, numbers and booleans')
		this.index += raw.length
		return { kind: 'scalar', raw }
	}

	private array(): TomlValue {
		this.index++
		const items: TomlValue[] = []
		for (;;) {
			this.skipSpace()
			if (this.index >= this.text.length || this.text[this.index] === '#') throw new Unsupported('an array over more than one line')
			if (this.text[this.index] === ']') {
				this.index++
				return { kind: 'array', items }
			}
			items.push(this.value())
			this.skipSpace()
			if (this.text[this.index] === ',') this.index++
			else if (this.text[this.index] !== ']') throw new Unsupported("expected ',' or ']'")
		}
	}
}

/** Decode `text`, or say on which line it leaves the subset. */
export function parseToml(text: string): TomlDocument {
	const entries: TomlEntry[] = []
	let table: readonly string[] = []
	const lines = text.split('\n')
	for (const [index, raw] of lines.entries()) {
		const line = new Line(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
		try {
			if (line.atEnd()) continue
			if (line.rest().startsWith('[[')) throw new Unsupported('an array of tables')
			if (line.rest().startsWith('[')) {
				line.expect('[')
				table = line.key()
				line.expect(']')
			} else {
				const key = line.key()
				line.expect('=')
				entries.push({ key: [...table, ...key], value: line.value(), line: index + 1 })
			}
			if (!line.atEnd()) throw new Unsupported('text after the value')
		} catch (error) {
			if (!(error instanceof Unsupported)) throw error
			return { ok: false, line: index + 1, message: error.message }
		}
	}
	return { ok: true, entries }
}

/** Whether the decoded key is `expected`. */
export const isKey = (entry: TomlEntry, ...expected: readonly string[]): boolean =>
	entry.key.length === expected.length && entry.key.every((part, index) => part === expected[index])
