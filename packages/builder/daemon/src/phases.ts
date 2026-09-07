import { existsSync, readdirSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'

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
	index: number
	title: string
	reads: string[]
	produces: string[]
	gate: boolean
	gateName?: string
}

export const PHASES: Phase[] = [
	{
		id: 'intake',
		index: 1,
		title: 'Intake (brief → classification)',
		reads: ['intent/brief.md'],
		produces: ['intent/brief.md'],
		gate: true,
		gateName: 'intake',
	},
	{
		id: 'vision',
		index: 2,
		title: 'Vision + scope + principles',
		reads: ['intent/brief.md'],
		produces: ['intent/glossary.md', 'principles/principles.md'],
		gate: true,
		gateName: 'vision',
	},
	{
		id: 'flows',
		index: 3,
		title: 'User flows',
		reads: ['intent/*', 'principles/*'],
		produces: ['architecture/flows/*.flow.md'],
		gate: true,
		gateName: 'flows',
	},
	{
		id: 'tech',
		index: 4,
		title: 'Tech + scaffold decision',
		reads: ['architecture/flows/*'],
		produces: ['architecture/tech.md'],
		gate: true,
		gateName: 'tech',
	},
	{
		id: 'design',
		index: 5,
		title: 'Design tokens + mockups',
		reads: ['architecture/flows/*', 'architecture/tech.md'],
		produces: ['architecture/design.md', 'pages/*.jsx'],
		gate: true,
		gateName: 'design',
	},
	{
		id: 'skeletons',
		index: 6,
		title: 'Opice skeletons',
		reads: ['architecture/flows/*', 'architecture/spec/*'],
		produces: ['../tests/browser/*.test.ts'],
		gate: true,
		gateName: 'skeletons',
	},
	{
		id: 'issues',
		index: 7,
		title: 'Induce issues (compile step, not a real phase — SPEC §6.4)',
		reads: ['../tests/browser/*'],
		produces: ['issues/ISSUE-*.md'],
		gate: false,
	},
	{
		id: 'build',
		index: 8,
		title: 'Build (agent-assisted, supervised subagents)',
		reads: ['issues/*'],
		produces: [],
		gate: true,
		gateName: 'build',
	},
]

export interface PhaseState {
	current: PhaseId
	index: number
	completed: PhaseId[]
	reads: string[]
	produces: string[]
	gate: boolean
	gateName?: string
	satisfied: boolean
}

export interface GateOracle {
	getLatestUnconsumedFeedback(sessionId: string): { revision: number; feedback: string } | null
	hasGateRevision?(sessionId: string, gateName: string): boolean
}

function expandGlob(fabrikaDir: string, glob: string): string[] {
	const abs = join(fabrikaDir, glob)
	if (!abs.includes('*')) {
		return existsSync(abs) ? [abs] : []
	}
	const dir = dirname(abs)
	const pattern = basename(abs) // e.g. "*.flow.md", "ISSUE-*.md", "*"
	if (!existsSync(dir)) return []

	const re = globToRegExp(pattern)
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		if (re.test(name)) out.push(join(dir, name))
	}
	return out
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
	return new RegExp(`^${escaped}$`)
}

function isNonEmptyFile(p: string): boolean {
	try {
		const s = statSync(p)
		return s.isFile() && s.size > 0
	} catch {
		return false
	}
}

export function producesSatisfied(phase: Phase, fabrikaDir: string): boolean {
	if (phase.produces.length === 0) return false
	for (const glob of phase.produces) {
		const matches = expandGlob(fabrikaDir, glob).filter(isNonEmptyFile)
		if (matches.length === 0) return false
	}
	return true
}

export function gateSatisfied(
	phase: Phase,
	sessionId: string,
	oracle?: GateOracle,
): boolean {
	if (!phase.gate) return true
	if (!oracle) return true
	if (oracle.getLatestUnconsumedFeedback(sessionId) !== null) return false
	if (oracle.hasGateRevision && phase.gateName) {
		return oracle.hasGateRevision(sessionId, phase.gateName)
	}
	return true
}

function resolveReads(phase: Phase, fabrikaDir: string): string[] {
	const out: string[] = []
	for (const glob of phase.reads) {
		out.push(
			...expandGlob(fabrikaDir, glob).filter(p => {
				try {
					return statSync(p).size > 0 || statSync(p).isDirectory()
				} catch {
					return false
				}
			}),
		)
	}
	return out
}

export function derivePhaseState(
	fabrikaDir: string,
	sessionId = '',
	oracle?: GateOracle,
): PhaseState {
	const completed: PhaseId[] = []

	for (const phase of PHASES) {
		if (producesSatisfied(phase, fabrikaDir) && gateSatisfied(phase, sessionId, oracle)) {
			completed.push(phase.id)
			continue
		}
		return {
			current: phase.id,
			index: phase.index,
			completed,
			reads: resolveReads(phase, fabrikaDir),
			produces: phase.produces,
			gate: phase.gate,
			...(phase.gateName ? { gateName: phase.gateName } : {}),
			satisfied: producesSatisfied(phase, fabrikaDir),
		}
	}

	const build = PHASES[PHASES.length - 1]!
	return {
		current: build.id,
		index: build.index,
		completed: completed.filter(id => id !== build.id),
		reads: resolveReads(build, fabrikaDir),
		produces: build.produces,
		gate: build.gate,
		...(build.gateName ? { gateName: build.gateName } : {}),
		satisfied: false,
	}
}
