/** The flat `key: value` front matter the builder's own Markdown files carry; lists are `[a, b]` on one line. */
export interface FrontMatter {
	body: Record<string, string>
	rest: string
}

export function extractFrontMatter(raw: string): FrontMatter {
	// An editor's byte-order mark would otherwise hide the whole front matter.
	const m = raw.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
	if (!m) return { body: {}, rest: raw }
	const body: Record<string, string> = {}
	for (const line of (m[1] ?? '').split(/\r?\n/)) {
		const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
		if (kv && kv[1]) body[kv[1]] = (kv[2] ?? '').trim()
	}
	return { body, rest: (m[2] ?? '').trim() }
}

export function scalar(v: string | undefined): string | undefined {
	if (v === undefined) return undefined
	return v.replace(/^["']|["']$/g, '')
}

export function list(v: string | undefined): string[] {
	if (!v) return []
	const inner = v.replace(/^\[/, '').replace(/\]$/, '')
	if (inner.trim() === '') return []
	return inner
		.split(',')
		.map((s) => s.trim().replace(/^["']|["']$/g, ''))
		.filter((s) => s.length > 0)
}
