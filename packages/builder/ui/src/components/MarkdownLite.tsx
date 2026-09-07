import type { JSX } from 'react'

function inline(text: string): (JSX.Element | string)[] {
	const out: (JSX.Element | string)[] = []
	const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
	let last = 0
	let m: RegExpExecArray | null
	let key = 0
	while ((m = re.exec(text))) {
		if (m.index > last) out.push(text.slice(last, m.index))
		const tok = m[0]
		if (tok.startsWith('`')) {
			out.push(
				<code key={key++} className="rounded bg-bg-code px-1 py-0.5 font-mono text-code text-text-code">
					{tok.slice(1, -1)}
				</code>,
			)
		} else {
			out.push(
				<strong key={key++} className="font-semibold text-text-primary">
					{tok.slice(2, -2)}
				</strong>,
			)
		}
		last = m.index + tok.length
	}
	if (last < text.length) out.push(text.slice(last))
	return out
}

export function MarkdownLite({ source }: { source: string }): JSX.Element {
	const lines = source.split('\n')
	const blocks: JSX.Element[] = []
	let i = 0
	let key = 0

	while (i < lines.length) {
		const line = lines[i]!

		if (line.startsWith('```')) {
			const buf: string[] = []
			i++
			while (i < lines.length && !lines[i]!.startsWith('```')) buf.push(lines[i++]!)
			i++ // closing fence
			blocks.push(
				<pre
					key={key++}
					className="my-3 overflow-auto rounded-md border border-border-subtle bg-bg-code p-3 font-mono text-code text-text-code"
				>
          <code>{buf.join("\n")}</code>
				</pre>,
			)
			continue
		}

		const h = line.match(/^(#{1,4})\s+(.*)$/)
		if (h) {
			const level = h[1]!.length
			const cls = level === 1
				? 'mt-2 mb-3 font-heading text-section text-text-primary'
				: level === 2
				? 'mt-5 mb-2 font-heading text-xl text-text-primary'
				: 'mt-4 mb-1 text-task-label font-semibold text-text-secondary uppercase tracking-wide'
			blocks.push(
				<div key={key++} className={cls}>
					{inline(h[2]!)}
				</div>,
			)
			i++
			continue
		}

		if (/^[-*]\s+/.test(line)) {
			const items: string[] = []
			while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
				items.push(lines[i]!.replace(/^[-*]\s+/, ''))
				i++
			}
			blocks.push(
				<ul key={key++} className="my-2 list-disc space-y-1 pl-5 text-body text-text-secondary">
					{items.map((it, n) => <li key={n}>{inline(it)}</li>)}
				</ul>,
			)
			continue
		}

		if (/^\d+\.\s+/.test(line)) {
			const items: string[] = []
			while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
				items.push(lines[i]!.replace(/^\d+\.\s+/, ''))
				i++
			}
			blocks.push(
				<ol key={key++} className="my-2 list-decimal space-y-1 pl-5 text-body text-text-secondary">
					{items.map((it, n) => <li key={n}>{inline(it)}</li>)}
				</ol>,
			)
			continue
		}

		if (line.trim() === '') {
			i++
			continue
		}

		blocks.push(
			<p key={key++} className="my-2 text-body leading-relaxed text-text-secondary">
				{inline(line)}
			</p>,
		)
		i++
	}

	return <div className="select-text">{blocks}</div>
}
