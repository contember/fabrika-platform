// The test cases of a `bun test --reporter=junit` report: which ran, and how each ended. Only what `fabrika db
// test-isolation` needs to tell a passed case from a skipped, failed or missing one.

export type CaseOutcome = 'passed' | 'failed' | 'skipped'

export interface ReportedCase {
	/** The test file, relative to the directory `bun test` ran in. */
	readonly file: string
	readonly name: string
	readonly outcome: CaseOutcome
}

const ENTITIES: Readonly<Record<string, string>> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }

const unescape = (text: string): string => text.replace(/&(quot|apos|lt|gt|amp);/g, (_, name: string) => ENTITIES[name] ?? '')

const attribute = (attributes: string, name: string): string | undefined => {
	const match = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)
	return match?.[1] === undefined ? undefined : unescape(match[1])
}

export function readJunitCases(xml: string): ReportedCase[] {
	const cases: ReportedCase[] = []
	for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
		const attributes = match[1] ?? ''
		const content = match[3] ?? ''
		const file = attribute(attributes, 'file')
		const name = attribute(attributes, 'name')
		if (file === undefined || name === undefined) continue
		const outcome: CaseOutcome = /<(failure|error)\b/.test(content) ? 'failed' : /<skipped\b/.test(content) ? 'skipped' : 'passed'
		cases.push({ file: file.replace(/^\.\//, ''), name, outcome })
	}
	return cases
}
