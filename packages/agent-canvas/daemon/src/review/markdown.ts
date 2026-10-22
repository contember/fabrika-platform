import type { ReviewAnchor, ReviewThread } from './model'

function fence(language: string, text: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
	const marker = '`'.repeat(longest + 1)
	return `${marker}${language}\n${text}\n${marker}`
}

function describeAnchor(anchor: ReviewAnchor, screenshot: string | undefined): string[] {
	const lines = [`- Page: ${anchor.url}`]
	if (anchor.context !== undefined) lines.push(`- Where: ${anchor.context}`)
	const accessible = [anchor.role, anchor.name === undefined ? undefined : `"${anchor.name}"`].filter((part) => part !== undefined).join(' ')
	if (accessible !== '') lines.push(`- Element: ${accessible}`)
	if (anchor.selector !== '') lines.push(`- Selector: \`${anchor.selector}\``)
	if (anchor.components !== undefined && anchor.components.length > 0) lines.push(`- Components: ${anchor.components.join(' › ')}`)
	if (anchor.sources !== undefined && anchor.sources.length > 0) {
		lines.push('- Source, innermost first:')
		for (const source of anchor.sources) lines.push(`  - ${source.label}: \`${source.file}:${source.line}:${source.column}\``)
	}
	if (anchor.quote !== undefined) {
		lines.push(`- Selected text: …${anchor.quote.before}**${anchor.quote.exact}**${anchor.quote.after}…`)
	} else if (anchor.text !== undefined && anchor.text !== '' && anchor.text !== anchor.name) {
		lines.push(`- Text: "${anchor.text}"`)
	}
	if (anchor.browser !== undefined) {
		const { name, viewport, colorScheme } = anchor.browser
		lines.push(`- Browser: ${name}, viewport ${viewport.width}×${viewport.height} @${viewport.scale}x, ${colorScheme} color scheme`)
	}
	if (anchor.style !== undefined) lines.push(`- Computed style: \`${anchor.style}\``)
	if (screenshot !== undefined) lines.push(`- Screenshot, the element outlined in red: \`${screenshot}\` (read the file to see it)`)
	if (anchor.html !== undefined) lines.push('- Markup, trimmed:', '', fence('html', anchor.html))
	return lines
}

function quoteBody(body: string): string {
	return body.split('\n').map((line) => `> ${line}`).join('\n')
}

/** The requests a waiting agent receives: each thread with its place in the page, its conversation and how to answer. */
export function renderReviewRequests(project: string, threads: readonly ReviewThread[]): string {
	const sections = threads.map((thread, index) => {
		const conversation = thread.comments.map((comment) => `**${comment.author === 'user' ? 'Reviewer' : 'You'}:**\n${quoteBody(comment.body)}`)
		return [`## ${index + 1}. Thread ${thread.id}`, '', ...describeAnchor(thread.anchor, thread.screenshot), '', ...conversation].join('\n')
	})
	return [
		`# Review requests for ${project}`,
		'',
		`The reviewer sent ${threads.length === 1 ? 'one thread' : `${threads.length} threads`} from the running application.`,
		'Make the change each thread asks for, then answer it so the reviewer sees what happened:',
		'',
		`    bunx agent-canvas review reply <thread-id> "<what you changed>" --resolve --project ${project}`,
		'',
		'Leave out `--resolve` when you ask a question back instead.',
		'',
		...sections.flatMap((section) => [section, '']),
	].join('\n')
}
