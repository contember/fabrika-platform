/** The longest label an administrator may give a terminal, in code points. */
export const MAX_TERMINAL_LABEL_LENGTH = 100

/**
 * A terminal's label as stored, or null when it may not be one: trimmed, 1 to `MAX_TERMINAL_LABEL_LENGTH` code points,
 * no control character. It reaches a person's token as `terminal.label` and every page that names the terminal.
 */
export function terminalLabel(raw: string): string | null {
	const label = raw.trim()
	const length = [...label].length
	if (length === 0 || length > MAX_TERMINAL_LABEL_LENGTH || /\p{Cc}/u.test(label)) {
		return null
	}
	return label
}
