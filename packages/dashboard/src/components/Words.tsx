/**
 * Words of the access diff or the surface with each `name` set as code, the way they quote identifiers. An odd count of
 * backticks leaves the last one open: the text then shows as it is.
 */
export function Words({ text }: { text: string }) {
	const parts = text.split('`')
	if (parts.length % 2 === 0) return <>{text}</>
	return <>{parts.map((part, index) => (index % 2 === 1 ? <code key={`${index}:${part}`}>{part}</code> : part))}</>
}
