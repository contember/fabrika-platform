import type { StackPointer } from './catalog'
import type { Skeleton } from './skeletons'

export interface InducedIssue {
	id: string
	goal: string
	satisfies: string[]
	dependsOn: string[]
	touches: string[]
	body: string
	kind: 'foundation' | 'feature'
}

const FOUNDATION_SCAFFOLD = 'ISSUE-001'
const FOUNDATION_DATA = 'ISSUE-002'
const FOUNDATION_AUTH = 'ISSUE-003'

export interface InduceOpts {
	stack?: StackPointer
}

export function induceIssues(skeletons: Skeleton[], opts: InduceOpts = {}): InducedIssue[] {
	if (skeletons.length === 0) return []
	const issues: InducedIssue[] = []

	const allSeeds = uniq(skeletons.flatMap((s) => s.seeds))
	const allRoles = uniq(skeletons.flatMap((s) => s.roles))
	const allUrls = uniq(skeletons.map((s) => s.url).filter((u): u is string => !!u))

	const stackRef = opts.stack && opts.stack.stackFileExists
		? [
			`Stack preset: ${opts.stack.stackFile}`,
			`Decisions:    ${opts.stack.decisionsDir}/  (resolve the preset's \`decisions:\` ids; read their live \`sources\`)`,
			'',
		]
		: []

	issues.push({
		id: FOUNDATION_SCAFFOLD,
		kind: 'foundation',
		goal: 'Stand up the running app + the routes every scenario navigates to.',
		satisfies: [],
		dependsOn: [],
		touches: ['app scaffold', 'routing', ...allUrls.map((u) => `route: ${u}`)],
		body: [
			...stackRef,
			'Foundation. Scaffold the running app per the active stack preset — read its',
			'decisions + the live sources they point to, and scaffold from current APIs (do',
			'NOT copy templates). Register a route for every URL a scenario targets so the',
			'dev server serves them.',
			'',
			'Routes that must exist (from skeleton `url` metadata). The URL is the contract;',
			'the file location is your call per the stack conventions:',
			...(allUrls.length ? allUrls.map((u) => `- \`${u}\``) : ['- (none declared)']),
		].join('\n'),
	})

	if (allSeeds.length) {
		issues.push({
			id: FOUNDATION_DATA,
			kind: 'foundation',
			goal: 'Data layer: schema migrations + the named idempotent seeds scenarios rely on.',
			satisfies: [],
			dependsOn: [FOUNDATION_SCAFFOLD],
			touches: ['schema/migrations', ...allSeeds.map((s) => `seed: ${s}`)],
			body: [
				'Foundation. Define the schema (idempotent migrations) and one named',
				'idempotent seed per `seeds:` value, keyed on stable ids.',
				'',
				'Named seeds to provide (union of skeleton `seeds`):',
				...allSeeds.map((s) => `- \`${s}\``),
			].join('\n'),
		})
	}

	if (allRoles.length) {
		issues.push({
			id: FOUNDATION_AUTH,
			kind: 'foundation',
			goal: 'Auth: the roles scenarios act as, and the means to act as each.',
			satisfies: [],
			dependsOn: [FOUNDATION_SCAFFOLD],
			touches: ['auth', 'identities'],
			body: [
				'Foundation. Provide auth for every acting identity in the skeletons.',
				'',
				'Roles to support (union of skeleton `roles`):',
				...allRoles.map((r) => `- \`${r}\``),
			].join('\n'),
		})
	}

	let n = 101
	for (const s of skeletons) {
		const deps = [FOUNDATION_SCAFFOLD]
		if (s.seeds.length && allSeeds.length) deps.push(FOUNDATION_DATA)
		if (s.roles.length && allRoles.length) deps.push(FOUNDATION_AUTH)

		const satisfies = [s.feature ?? s.name, ...s.invariants]

		issues.push({
			id: `ISSUE-${n}`,
			kind: 'feature',
			goal: `Implement the vertical slice for "${s.name}"${s.url ? ` at ${s.url}` : ''}.`,
			satisfies: uniq(satisfies),
			dependsOn: deps,
			touches: uniq([s.url ? `route: ${s.url}` : 'feature route/UI', ...s.seeds.map((sd) => `seed: ${sd}`)]),
			body: [
				`Feature slice satisfying the scenario **${s.name}**` + (s.feature ? ` (\`${s.feature}\`)` : '') + '.',
				'',
				`- Route + data: serve URL \`${
					s.url ?? '(unspecified)'
				}\` — the URL is a contract (must match the skeleton); choose the file per the stack conventions.`,
				s.seeds.length ? `- Seeds: ${s.seeds.map((x) => `\`${x}\``).join(', ')}.` : '- Seeds: none.',
				s.roles.length ? `- Roles: ${s.roles.map((x) => `\`${x}\``).join(', ')}.` : '- Roles: none.',
				'- Semantic, accessible markup so opice-author finds stable selectors.',
				s.invariants.length ? '\nInvariants to satisfy (frozen — do not weaken):' : '',
				...s.invariants.map((iv) => `- ${iv}`),
				`\nAcceptance: \`${relTest(s.file)}\` goes green (\`bun test\`).`,
			].filter((x) => x !== '').join('\n'),
		})
		n++
	}

	return issues
}

export function renderIssue(issue: InducedIssue): string {
	const fm = [
		'---',
		`goal: ${issue.goal}`,
		`satisfies: [${issue.satisfies.map(q).join(', ')}]`,
		`depends_on: [${issue.dependsOn.map(q).join(', ')}]`,
		`touches: [${issue.touches.map(q).join(', ')}]`,
		'---',
	].join('\n')
	return `${fm}\n\n# ${issue.id} — ${issue.goal}\n\n${issue.body}\n`
}

function relTest(file: string): string {
	const i = file.indexOf('tests/browser/')
	return i !== -1 ? file.slice(i) : file
}

function uniq<T>(xs: T[]): T[] {
	return [...new Set(xs)]
}

function q(s: string): string {
	return `"${s.replace(/"/g, '\\"')}"`
}
