// Character comparisons only: no RegExp or String.prototype method that same-process code could replace.

const MAX_LENGTH = 63

function isIdentifierRange(value: string, start: number, end: number): boolean {
	if (end <= start || end - start > MAX_LENGTH) {
		return false
	}
	for (let index = start; index < end; index++) {
		const char = value[index] ?? ''
		const lower = char >= 'a' && char <= 'z'
		const digit = char >= '0' && char <= '9'
		if (!(lower || char === '_' || (index > start && digit))) {
			return false
		}
	}
	return true
}

/** `^[a-z_][a-z0-9_]*$`, at most 63 characters (Postgres truncates longer names). */
export function isPlainIdentifier(value: unknown): value is string {
	return typeof value === 'string' && isIdentifierRange(value, 0, value.length)
}

/** A plain identifier, or two joined by one dot (`note_comments.body`, the alias of a joined column). */
export function isPlainAlias(value: unknown): value is string {
	if (typeof value !== 'string') {
		return false
	}
	let dot = -1
	for (let index = 0; index < value.length; index++) {
		if (value[index] === '.') {
			if (dot !== -1) {
				return false
			}
			dot = index
		}
	}
	if (dot === -1) {
		return isIdentifierRange(value, 0, value.length)
	}
	return isIdentifierRange(value, 0, dot) && isIdentifierRange(value, dot + 1, value.length)
}
