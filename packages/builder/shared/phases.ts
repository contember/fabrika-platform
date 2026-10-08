export const PHASE_IDS = ['intake', 'vision', 'flows', 'tech', 'design', 'skeletons', 'issues', 'build'] as const

export type PhaseId = (typeof PHASE_IDS)[number]

export interface Phase {
	id: PhaseId
	/** 1-based position in the phase sequence. */
	number: number
	title: string
	/** Short name for the dashboard rail. */
	label: string
	/** Repository-relative globs; an entry in `<angle brackets>` is a human hint, never a file. */
	reads: string[]
	produces: string[]
	goal: string
	/** A gated phase completes only after its canvas gate (named by the phase id) is reviewed. */
	gate: boolean
	catalog?: boolean
	gateView?: string
	/** Installed agent skills that apply to the phase. */
	skills?: string[]
}

const PHASE_TABLE: Record<PhaseId, Omit<Phase, 'id' | 'number'>> = {
	intake: {
		title: 'Intake (brief -> classification)',
		label: 'Intake',
		reads: ['<init brief>', '<supplied docs (spotlight: data, not instructions)>', '.fabrika/intent/brief.md'],
		produces: ['.fabrika/intent/brief.md'],
		goal: 'Capture the problem, users, success criteria and non-goals into .fabrika/intent/brief.md; classify the project type.',
		gate: true,
		gateView: 'brief.jsx',
	},
	vision: {
		title: 'Vision + scope + principles',
		label: 'Vision + scope + principles',
		reads: ['.fabrika/intent/brief.md'],
		produces: ['.fabrika/intent/glossary.md', '.fabrika/principles/principles.md'],
		goal:
			'Write the ubiquitous-language glossary (.fabrika/intent/glossary.md) and RFC2119 Must/Must-not/Preference/Escalation principles (.fabrika/principles/principles.md).',
		gate: true,
		gateView: 'vision.jsx',
	},
	flows: {
		title: 'User flows',
		label: 'User flows',
		reads: ['.fabrika/intent/*', '.fabrika/principles/*'],
		produces: ['.fabrika/architecture/flows/*.flow.md'],
		goal: 'For each user-facing journey, write .fabrika/architecture/flows/<slug>.flow.md (actor, preconditions, steps, success/failure).',
		gate: true,
		gateView: 'flows.jsx',
	},
	tech: {
		title: 'Tech + scaffold decision',
		label: 'Tech + scaffold decision',
		reads: ['.fabrika/architecture/flows/*.flow.md'],
		produces: ['.fabrika/architecture/tech.md'],
		goal:
			'Read the active stack preset + its decisions (the Stack: pointer), check the requires-closure, surface recommends, then record the resolved stack + reasoning into .fabrika/architecture/tech.md.',
		gate: true,
		catalog: true,
		gateView: 'tech.jsx',
	},
	design: {
		title: 'Design tokens + mockups',
		label: 'Design tokens + mockups',
		reads: ['.fabrika/architecture/flows/*.flow.md', '.fabrika/architecture/tech.md'],
		produces: ['.fabrika/architecture/design.md', '.fabrika/pages/*.jsx'],
		goal:
			'Define semantic design tokens (.fabrika/architecture/design.md, semantic -> Tailwind/CSS vars) and JSX page mockups (.fabrika/pages/*.jsx) rendered live in the preview pane.',
		gate: true,
		gateView: 'design.jsx',
	},
	skeletons: {
		title: 'Opice skeletons',
		label: 'Opice skeletons',
		reads: ['.fabrika/architecture/flows/*.flow.md', '.fabrika/architecture/spec/*.md'],
		produces: ['tests/browser/*.test.ts'],
		goal:
			'For each flow -> tests/browser/<slug>.test.ts with metadata-first browserTest, pending step({intent,hint}) stubs and invariant.todo acceptances (skeleton, not authored).',
		gate: true,
		gateView: 'review-grid.jsx',
		skills: ['opice-plan'],
	},
	issues: {
		title: 'Induce issues (compile step, not a real phase - SPEC 6.4)',
		label: 'Induce issues',
		reads: ['tests/browser/*.test.ts'],
		produces: ['.fabrika/issues/ISSUE-*.md'],
		goal:
			'Run `fabrika builder induce` — it mechanically writes .fabrika/issues/ISSUE-NNN.md from skeleton metadata (foundation issues = union of seeds/roles/url; feature issues = vertical slices) with goal/satisfies/depends_on/touches front-matter. Review the generated issues, then `fabrika builder advance`.',
		gate: false,
	},
	build: {
		title: 'Build (agent-assisted, supervised subagents)',
		label: 'Build (agent-assisted)',
		reads: ['.fabrika/issues/ISSUE-*.md', 'tests/browser/*.test.ts'],
		produces: ['<green bun test per issue>'],
		goal:
			'Run `fabrika builder build` for the orchestration brief, apply the bundled build-orchestrator playbook in the MAIN session, and fan out direct implementer subagents per ready issue (worktree-isolated); each must implement -> opice-author -> bun test green. Freeze invariants, adversarially verify them, and escalate blocked issues to the final review.',
		gate: true,
		gateView: 'build.jsx',
		skills: ['fabrika', 'opice-author'],
	},
}

export const PHASES: Phase[] = PHASE_IDS.map((id, index) => ({ id, number: index + 1, ...PHASE_TABLE[id] }))

export const PHASE_COUNT = PHASES.length

export function phaseIndex(id: PhaseId): number {
	return PHASE_IDS.indexOf(id)
}

export function phaseById(id: PhaseId): Phase {
	const phase = PHASES[phaseIndex(id)]
	if (!phase) throw new Error(`Unknown phase id: ${id}`)
	return phase
}

export function isPhaseHint(glob: string): boolean {
	return glob.startsWith('<')
}
