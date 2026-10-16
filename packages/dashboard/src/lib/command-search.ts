// The command palette's matching: what a few typed letters find among pages, actions and the installation's objects.
// Every word typed must match the command's title or one of its keywords. A word matches best at the start of the
// title, then at the start of a word in it, then anywhere in it. In a title it also matches as letters in order that
// begin a word (`dpr` finds "Deploy runs"); anywhere else that finds too much.
// Ties keep the order the commands were given in, so a page stays above an object of the same score.

export interface Searchable {
	title: string
	/** Other words that find the command: its section, an id, an email. */
	keywords?: readonly string[]
}

const PREFIX = 100
const WORD_START = 60
const CONTAINS = 30
const IN_ORDER = 10

function wordScore(word: string, text: string, inOrder: boolean): number {
	const lower = text.toLowerCase()
	if (lower.startsWith(word)) return PREFIX
	const at = lower.indexOf(word)
	if (at > 0 && !WORD_CHAR.test(lower.charAt(at - 1))) return WORD_START
	if (lower.split(/[^\p{L}\p{N}]+/u).some((part) => part.startsWith(word))) return WORD_START
	if (at >= 0) return CONTAINS
	if (!inOrder) return 0
	for (const start of wordStarts(lower)) {
		if (lower.charAt(start) !== word.charAt(0)) continue
		let index = 0
		for (const char of lower.slice(start)) {
			if (char === word.charAt(index)) index++
			if (index === word.length) return IN_ORDER
		}
	}
	return 0
}

const WORD_CHAR = /[\p{L}\p{N}]/u

function wordStarts(text: string): number[] {
	const starts: number[] = []
	for (let index = 0; index < text.length; index++) {
		if (WORD_CHAR.test(text.charAt(index)) && (index === 0 || !WORD_CHAR.test(text.charAt(index - 1)))) starts.push(index)
	}
	return starts
}

/** How well a query finds a command: 0 when some typed word matches nothing. A keyword match counts for less. */
export function commandScore(query: string, command: Searchable): number {
	const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '')
	let total = 0
	for (const word of words) {
		const inTitle = wordScore(word, command.title, true)
		const inKeywords = Math.max(0, ...(command.keywords ?? []).map((keyword) => wordScore(word, keyword, false) - 5))
		const best = Math.max(inTitle, inKeywords)
		if (best <= 0) return 0
		total += best
	}
	return total
}

/** The commands a query finds, best first; an empty query keeps the given order. */
export function rankCommands<T extends Searchable>(commands: readonly T[], query: string, limit = 40): T[] {
	if (query.trim() === '') return commands.slice(0, limit)
	return commands
		.map((command, index) => ({ command, index, score: commandScore(query, command) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.command)
}
