// The one phase derivation, shared by the CLI and the daemon. It reads the filesystem, so the dashboard never imports it.
import { existsSync, readdirSync, statSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { GateVerdict } from './gate'
import { isPhaseHint, type Phase, type PhaseId, phaseIndex, PHASES } from './phases'

export interface PhaseState {
	current: PhaseId
	index: number
	completed: PhaseId[]
	reads: string[]
	produces: string[]
	gate: boolean
	satisfied: boolean
	/** The verdict of each completed gated phase whose review is known. */
	verdicts: Partial<Record<PhaseId, GateVerdict>>
	/** Completed gated phases whose review could not be checked (no daemon); they are assumed reviewed. */
	unverified: PhaseId[]
}

/** A gate's review: `reviewed` once its latest revision's feedback was consumed by `advance`. */
export interface GateReview {
	reviewed: boolean
	verdict: GateVerdict
}

export type GateProbe = (phase: Phase) => GateReview | 'unknown'

/** Without the daemon no review can be checked; the derivation then says so instead of guessing. */
export const offlineGateProbe: GateProbe = () => 'unknown'

export function matchGlob(repoRoot: string, glob: string): string[] {
	if (!glob.includes('*')) {
		const abs = resolve(repoRoot, glob)
		return existsSync(abs) ? [abs] : []
	}

	const dirPart = dirname(glob)
	const filePart = basename(glob)
	const absDir = resolve(repoRoot, dirPart)
	if (!existsSync(absDir) || !statSync(absDir).isDirectory()) return []

	const re = globSegmentToRegExp(filePart)
	const out: string[] = []
	for (const entry of readdirSync(absDir)) {
		if (re.test(entry)) out.push(join(absDir, entry))
	}
	return out
}

function globSegmentToRegExp(seg: string): RegExp {
	const escaped = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
	return new RegExp(`^${escaped}$`)
}

export function isNonEmptyFile(p: string): boolean {
	try {
		const st = statSync(p)
		return st.isFile() && st.size > 0
	} catch {
		return false
	}
}

export function producesSatisfied(repoRoot: string, phase: Phase): boolean {
	for (const glob of phase.produces) {
		if (isPhaseHint(glob)) return false
		const matches = matchGlob(repoRoot, glob).filter(isNonEmptyFile)
		if (matches.length === 0) return false
	}
	return true
}

export function resolveReads(repoRoot: string, phase: Phase): string[] {
	const out: string[] = []
	for (const glob of phase.reads) {
		if (isPhaseHint(glob)) {
			out.push(glob) // keep the human hint, e.g. "<init brief>"
			continue
		}
		const matches = matchGlob(repoRoot, glob)
		if (matches.length > 0) {
			out.push(glob)
		}
	}
	return out
}

export function derivePhase(repoRoot: string, gateProbe: GateProbe = offlineGateProbe): PhaseState {
	const completed: PhaseId[] = []
	const verdicts: Partial<Record<PhaseId, GateVerdict>> = {}
	const unverified: PhaseId[] = []

	for (const phase of PHASES) {
		const produced = producesSatisfied(repoRoot, phase)
		if (!produced) return toState(repoRoot, phase, completed, false, verdicts, unverified)
		if (phase.gate) {
			const review = gateProbe(phase)
			if (review === 'unknown') unverified.push(phase.id)
			else if (!review.reviewed) return toState(repoRoot, phase, completed, true, verdicts, unverified)
			else verdicts[phase.id] = review.verdict
		}
		completed.push(phase.id)
	}

	const build = PHASES.at(-1)
	if (build === undefined) throw new Error('The builder has no phases')
	return toState(repoRoot, build, completed.filter((id) => id !== build.id), true, verdicts, unverified.filter((id) => id !== build.id))
}

function toState(
	repoRoot: string,
	phase: Phase,
	completed: PhaseId[],
	satisfied: boolean,
	verdicts: Partial<Record<PhaseId, GateVerdict>>,
	unverified: PhaseId[],
): PhaseState {
	return {
		current: phase.id,
		index: phaseIndex(phase.id),
		completed,
		reads: resolveReads(repoRoot, phase),
		produces: phase.produces,
		gate: phase.gate,
		satisfied,
		verdicts,
		unverified,
	}
}
