// The honeypot of a public procedure: a field its page hides, which a person leaves empty and a bot fills. The handler
// answers a filled one as it answers a real submission and does nothing, so the bot learns nothing from the answer.

/** Whether the hidden field was filled: `if (honeypot(input.website)) return {}`. */
export function honeypot(value: string | null | undefined): boolean {
	return typeof value === 'string' && value !== ''
}
