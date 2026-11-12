import { basename } from 'path'
import type { StackPointer } from './catalog'
import type { Skeleton } from './skeletons'

export interface InducedIssue {
	id: string
	goal: string
	satisfies: string[]
	dependsOn: string[]
	touches: string[]
	verify: string[]
	/** The review gate whose consumed verdict `build done` records instead of running a check. */
	gate?: string
	body: string
	kind: 'foundation' | 'feature'
}

const FOUNDATION_SCAFFOLD = 'ISSUE-001'
const FOUNDATION_DATA = 'ISSUE-002'
const FOUNDATION_AUTH = 'ISSUE-003'
const DESIGN_CHECKPOINT = 'ISSUE-004'

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
		verify: [],
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
			verify: [],
			body: [
				'Foundation. Define the schema (idempotent migrations) and one named',
				'idempotent seed per `seeds:` value, keyed on stable ids, in the form the',
				"stack preset's seed strategy names.",
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
			verify: [],
			body: [
				'Foundation. Provide auth for every acting identity in the skeletons.',
				'',
				'Roles to support (union of skeleton `roles`):',
				...allRoles.map((r) => `- \`${r}\``),
			].join('\n'),
		})
	}

	issues.push({
		id: DESIGN_CHECKPOINT,
		kind: 'foundation',
		goal: 'Design checkpoint: theme the running application and get the design gate reviewed.',
		satisfies: [],
		dependsOn: issues.map((i) => i.id),
		touches: ['theme stylesheet'],
		verify: [],
		gate: 'design',
		body: [
			'Foundation. The design is reviewed on the real application, not on drawings:',
			"the screens are the kit's components with the seeded data.",
			'',
			"1. Theme through the kit's tokens only: override `--fui-*` custom properties in the",
			"   SPA's own stylesheet, imported after `@fabrika/ui/styles.css` (the `fabrika-app`",
			'   skill\'s `spa.md`, "Theming"). Never restyle a `.fui-` class. On a stack without',
			"   `@fabrika/ui`, theme that stack's own tokens the same way.",
			'2. Record the decisions in `.fabrika/architecture/design.md`: each overridden token,',
			'   its value and why, and the stylesheet that holds them.',
			'3. Start the application with its seeds and publish its address:',
			'   `fabrika builder preview --url=<local url>`.',
			"4. Fill the skill's `gates/design.jsx` with the real tokens and the routes to look at,",
			'   then `fabrika builder gate open design --view <view.jsx> && fabrika builder gate wait`.',
			'5. On "Request changes", change the tokens and re-open the gate.',
			'6. `fabrika builder build done ' + DESIGN_CHECKPOINT + "` records the gate's verdict.",
			'',
			'Screens to review (skeleton `url` metadata):',
			...(allUrls.length ? allUrls.map((u) => `- \`${u}\``) : ['- (none declared)']),
		].join('\n'),
	})

	let n = 101
	for (const s of skeletons) {
		const deps = [FOUNDATION_SCAFFOLD]
		if (s.seeds.length && allSeeds.length) deps.push(FOUNDATION_DATA)
		if (s.roles.length && allRoles.length) deps.push(FOUNDATION_AUTH)
		deps.push(DESIGN_CHECKPOINT)

		const satisfies = [s.feature ?? s.name, ...s.invariants]

		issues.push({
			id: `ISSUE-${n}`,
			kind: 'feature',
			goal: `Implement the vertical slice for "${s.name}"${s.url ? ` at ${s.url}` : ''}.`,
			satisfies: uniq(satisfies),
			dependsOn: deps,
			touches: uniq([s.url ? `route: ${s.url}` : 'feature route/UI', ...s.seeds.map((sd) => `seed: ${sd}`)]),
			verify: [relTest(s.file)],
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
		`verify: [${issue.verify.map(q).join(', ')}]`,
		...(issue.gate ? [`gate: ${issue.gate}`] : []),
		'---',
	].join('\n')
	return `${fm}\n\n# ${issue.id} — ${issue.goal}\n\n${issue.body}\n`
}

// readSkeletons reads only the top level of the repository's tests/browser/.
function relTest(file: string): string {
	return `tests/browser/${basename(file)}`
}

function uniq<T>(xs: T[]): T[] {
	return [...new Set(xs)]
}

function q(s: string): string {
	return `"${s.replace(/"/g, '\\"')}"`
}
