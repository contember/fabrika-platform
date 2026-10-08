import { existsSync, readdirSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { isPhaseHint, type Phase, phaseById, type PhaseId, PHASES } from '../../shared/phases'

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

function expandGlob(repoRoot: string, glob: string): string[] {
	const abs = join(repoRoot, glob)
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

export function producesSatisfied(phase: Phase, repoRoot: string): boolean {
	for (const glob of phase.produces) {
		if (isPhaseHint(glob)) return false
		const matches = expandGlob(repoRoot, glob).filter(isNonEmptyFile)
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
	return oracle.hasGateRevision?.(sessionId, phase.id) ?? true
}

function resolveReads(phase: Phase, repoRoot: string): string[] {
	const out: string[] = []
	for (const glob of phase.reads.filter((read) => !isPhaseHint(read))) {
		out.push(
			...expandGlob(repoRoot, glob).filter(p => {
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
	const repoRoot = dirname(fabrikaDir)
	const completed: PhaseId[] = []

	for (const phase of PHASES) {
		const satisfied = producesSatisfied(phase, repoRoot)
		if (satisfied && gateSatisfied(phase, sessionId, oracle)) {
			completed.push(phase.id)
			continue
		}
		return toState(phase, repoRoot, completed, satisfied)
	}

	const build = phaseById('build')
	return toState(build, repoRoot, completed.filter(id => id !== build.id), false)
}

function toState(phase: Phase, repoRoot: string, completed: PhaseId[], satisfied: boolean): PhaseState {
	return {
		current: phase.id,
		index: phase.number,
		completed,
		reads: resolveReads(phase, repoRoot),
		produces: phase.produces,
		gate: phase.gate,
		...(phase.gate ? { gateName: phase.id } : {}),
		satisfied,
	}
}
