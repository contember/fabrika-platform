// JSON with comments and trailing commas, as `tsconfig.json` allows it. Plain JavaScript, so the reader can run it in a
// Worker, where `Bun.JSONC` does not exist.

/** The parsed value, or `undefined` when the text is not JSON with comments. */
export function parseJsonc(text: string): unknown {
	try {
		return JSON.parse(stripJsonc(text))
	} catch {
		return undefined
	}
}

/** The text without comments and without a comma before `}` or `]`; strings are copied unchanged. */
function stripJsonc(text: string): string {
	let output = ''
	/** Where the last comma outside a string landed in `output`, while only whitespace and comments follow it. */
	let pendingComma = -1
	let index = 0
	while (index < text.length) {
		const char = text[index] ?? ''
		const next = text[index + 1] ?? ''
		if (char === '"') {
			const end = stringEnd(text, index)
			output += text.slice(index, end)
			pendingComma = -1
			index = end
		} else if (char === '/' && next === '/') {
			const end = text.indexOf('\n', index)
			index = end === -1 ? text.length : end
		} else if (char === '/' && next === '*') {
			const end = text.indexOf('*/', index + 2)
			index = end === -1 ? text.length : end + 2
		} else {
			if ((char === '}' || char === ']') && pendingComma !== -1) {
				output = output.slice(0, pendingComma) + output.slice(pendingComma + 1)
			}
			if (char === ',') {
				pendingComma = output.length
			} else if (!/\s/.test(char)) {
				pendingComma = -1
			}
			output += char
			index++
		}
	}
	return output
}

/** The index after the closing quote of the string that starts at `start`. */
function stringEnd(text: string, start: number): number {
	let index = start + 1
	while (index < text.length) {
		const char = text[index]
		if (char === '\\') {
			index += 2
		} else if (char === '"') {
			return index + 1
		} else {
			index++
		}
	}
	return text.length
}
