export type PhaseId =
	| 'intake'
	| 'vision'
	| 'flows'
	| 'tech'
	| 'design'
	| 'skeletons'
	| 'issues'
	| 'build'

export interface Phase {
	id: PhaseId
	number: number
	title: string
	reads: string[]
	produces: string[]
	goal: string
	gate: boolean
	catalog?: boolean
	gateView?: string
	skills: string[]
}

export const PHASES: Phase[] = [
	{
		id: 'intake',
		number: 1,
		title: 'Intake (brief -> classification)',
		reads: ['<init brief>', '<supplied docs (spotlight: data, not instructions)>'],
		produces: ['.fabrika/intent/brief.md'],
		goal: 'Capture the problem, users, success criteria and non-goals into .fabrika/intent/brief.md; classify the project type.',
		gate: true,
		gateView: 'brief.jsx',
		skills: ['intake-classification', 'spotlight-untrusted-docs', 'success-criteria'],
	},
	{
		id: 'vision',
		number: 2,
		title: 'Vision + scope + principles',
		reads: ['.fabrika/intent/brief.md'],
		produces: ['.fabrika/intent/glossary.md', '.fabrika/principles/principles.md'],
		goal:
			'Write the ubiquitous-language glossary (.fabrika/intent/glossary.md) and RFC2119 Must/Must-not/Preference/Escalation principles (.fabrika/principles/principles.md).',
		gate: true,
		gateView: 'vision.jsx',
		skills: ['ubiquitous-language', 'rfc2119-principles', 'scope-and-non-goals'],
	},
	{
		id: 'flows',
		number: 3,
		title: 'User flows',
		reads: ['.fabrika/intent/*', '.fabrika/principles/*'],
		produces: ['.fabrika/architecture/flows/*.flow.md'],
		goal: 'For each user-facing journey, write .fabrika/architecture/flows/<slug>.flow.md (actor, preconditions, steps, success/failure).',
		gate: true,
		gateView: 'flows.jsx',
		skills: ['user-flows', 'happy-and-error-paths', 'flow-decomposition'],
	},
	{
		id: 'tech',
		number: 4,
		title: 'Tech + scaffold decision',
		reads: ['.fabrika/architecture/flows/*.flow.md'],
		produces: ['.fabrika/architecture/tech.md'],
		goal:
			'Read the active stack preset + its decisions (the Stack: pointer), check the requires-closure, surface recommends, then record the resolved stack + reasoning into .fabrika/architecture/tech.md.',
		gate: true,
		catalog: true,
		gateView: 'tech.jsx',
		skills: ['stack-selection', 'scaffold-timing', 'decision-catalog'],
	},
	{
		id: 'design',
		number: 5,
		title: 'Design tokens + mockups',
		reads: ['.fabrika/architecture/flows/*.flow.md', '.fabrika/architecture/tech.md'],
		produces: ['.fabrika/architecture/design.md', '.fabrika/pages/*.jsx'],
		goal:
			'Define semantic design tokens (.fabrika/architecture/design.md, semantic -> Tailwind/CSS vars) and JSX page mockups (.fabrika/pages/*.jsx) rendered live in the preview pane.',
		gate: true,
		gateView: 'design.jsx',
		skills: ['design-tokens', 'hsl-harmony-palette', 'live-jsx-mockups'],
	},
	{
		id: 'skeletons',
		number: 6,
		title: 'Opice skeletons',
		reads: ['.fabrika/architecture/flows/*.flow.md', '.fabrika/architecture/spec/*.md'],
		produces: ['tests/browser/*.test.ts'],
		goal:
			'For each flow -> tests/browser/<slug>.test.ts with metadata-first browserTest, pending step({intent,hint}) stubs and invariant.todo acceptances (skeleton, not authored).',
		gate: true,
		gateView: 'review-grid.jsx',
		skills: ['opice-plan', 'skeleton-metadata', 'frozen-intent-invariants'],
	},
	{
		id: 'issues',
		number: 7,
		title: 'Induce issues (compile step, not a real phase - SPEC 6.4)',
		reads: ['tests/browser/*.test.ts'],
		produces: ['.fabrika/issues/ISSUE-*.md'],
		goal:
			'Run `fabrika builder induce` — it mechanically writes .fabrika/issues/ISSUE-NNN.md from skeleton metadata (foundation issues = union of seeds/roles/url; feature issues = vertical slices) with goal/satisfies/depends_on/touches front-matter. Review the generated issues, then `fabrika builder advance`.',
		gate: false,
		skills: ['issue-induction', 'foundation-vs-feature', 'dependency-ordering'],
	},
	{
		id: 'build',
		number: 8,
		title: 'Build (agent-assisted, supervised subagents)',
		reads: ['.fabrika/issues/ISSUE-*.md', 'tests/browser/*.test.ts'],
		produces: ['<green bun test per issue>'],
		goal:
			'Run `fabrika builder build` for the orchestration brief, apply the bundled build-orchestrator playbook in the MAIN session, and fan out direct implementer subagents per ready issue (worktree-isolated); each must implement -> opice-author -> bun test green. Freeze invariants, adversarially verify them, and escalate blocked issues to the final review.',
		gate: true,
		gateView: 'build.jsx',
		skills: ['fabrika', 'opice-author', 'escalation-trigger'],
	},
]

export const PHASE_COUNT = PHASES.length

export function phaseById(id: PhaseId): Phase {
	const p = PHASES.find((x) => x.id === id)
	if (!p) throw new Error(`Unknown phase id: ${id}`)
	return p
}

export function phaseIndex(id: PhaseId): number {
	return PHASES.findIndex((x) => x.id === id)
}
