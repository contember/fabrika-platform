import type { ReviewAnchor, ReviewThread } from './model'

function describeAnchor(anchor: ReviewAnchor): string[] {
	const lines = [`- Page: ${anchor.url}`]
	const accessible = [anchor.role, anchor.name === undefined ? undefined : `"${anchor.name}"`].filter((part) => part !== undefined).join(' ')
	if (accessible !== '') lines.push(`- Element: ${accessible}`)
	if (anchor.selector !== '') lines.push(`- Selector: \`${anchor.selector}\``)
	if (anchor.components !== undefined && anchor.components.length > 0) lines.push(`- Components: ${anchor.components.join(' › ')}`)
	if (anchor.quote !== undefined) {
		lines.push(`- Selected text: …${anchor.quote.before}**${anchor.quote.exact}**${anchor.quote.after}…`)
	} else if (anchor.text !== undefined && anchor.text !== '') {
		lines.push(`- Text: "${anchor.text}"`)
	}
	return lines
}

function quoteBody(body: string): string {
	return body.split('\n').map((line) => `> ${line}`).join('\n')
}

/** The requests a waiting agent receives: each thread with its place in the page, its conversation and how to answer. */
export function renderReviewRequests(project: string, threads: readonly ReviewThread[]): string {
	const sections = threads.map((thread, index) => {
		const conversation = thread.comments.map((comment) => `**${comment.author === 'user' ? 'Reviewer' : 'You'}:**\n${quoteBody(comment.body)}`)
		return [`## ${index + 1}. Thread ${thread.id}`, '', ...describeAnchor(thread.anchor), '', ...conversation].join('\n')
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
