import type { PhaseDescriptor, PhaseId } from './types'

export const PHASES: PhaseDescriptor[] = [
	{
		id: 'intake',
		title: 'Intake',
		reads: 'init brief, supplied untrusted docs (spotlight)',
		produces: 'intent/brief.md',
		gate: true,
	},
	{
		id: 'vision',
		title: 'Vision + scope + principles',
		reads: 'intent/brief.md',
		produces: 'intent/glossary.md, principles/principles.md',
		gate: true,
	},
	{
		id: 'flows',
		title: 'User flows',
		reads: 'intent/*, principles/*',
		produces: 'architecture/flows/*.flow.md',
		gate: true,
	},
	{
		id: 'tech',
		title: 'Tech + scaffold decision',
		reads: 'architecture/flows/*, stack',
		produces: 'architecture/tech.md',
		gate: true,
	},
	{
		id: 'design',
		title: 'Design tokens + mockups',
		reads: 'architecture/flows/*, architecture/tech.md',
		produces: 'architecture/design.md, pages/*.jsx',
		gate: true,
	},
	{
		id: 'skeletons',
		title: 'Opice skeletons',
		reads: 'architecture/flows/*, architecture/spec/*',
		produces: 'tests/browser/*.test.ts (outside .fabrika)',
		gate: true,
	},
	{
		id: 'issues',
		title: 'Induce issues',
		reads: 'tests/browser/* metadata, named-seeds decision',
		produces: 'issues/ISSUE-*.md',
		gate: false,
	},
	{
		id: 'build',
		title: 'Build (agent-assisted)',
		reads: 'issues/*, tests/browser/*',
		produces: 'green bun test per issue',
		gate: true,
	},
]

export const PHASE_COUNT = PHASES.length

export function phaseIndex(id: PhaseId): number {
	return PHASES.findIndex((p) => p.id === id)
}

export function phaseById(id: PhaseId): PhaseDescriptor | undefined {
	return PHASES.find((p) => p.id === id)
}

export type PhaseStatus = 'done' | 'current' | 'upcoming'

export function statusOf(id: PhaseId, completed: PhaseId[], current: PhaseId): PhaseStatus {
	if (completed.includes(id)) return 'done'
	if (id === current) return 'current'
	return 'upcoming'
}
