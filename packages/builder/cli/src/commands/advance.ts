import { parseArgs } from 'util'
import { readApprovals, writeApprovals } from '../../../shared/approvals'
import { isNonEmptyFile, matchGlob, phaseInputs, producesSatisfied } from '../../../shared/derive'
import { GATE_CHANGES } from '../../../shared/gate'
import { PHASE_COUNT, phaseById, type PhaseId, phaseIndex, PHASES } from '../../../shared/phases'
import { resolveContext } from '../context'
import { consumeGate } from '../daemon-client'
import { isDaemonRunning } from '../daemon-lifecycle'
import { skeletonRouteWarnings } from '../flows'
import { resolvePhaseState } from '../phase-state'

export async function cmdAdvance(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			force: { type: 'boolean', default: false },
			dir: { type: 'string' },
			session: { type: 'string' },
		},
		allowPositionals: true,
	})

	const ctx = resolveContext({ dir: values.dir, session: values.session })
	if (!ctx.initialized) {
		console.error(`[fabrika] no .fabrika/ found at or above ${ctx.repoRoot}. Run \`fabrika builder init\` first.`)
		return 1
	}

	const { state } = await resolvePhaseState(ctx.repoRoot, ctx.fabrikaDir, ctx.sessionId)
	const phase = phaseById(state.current)
	const problems: string[] = []

	if (!producesSatisfied(ctx.repoRoot, phase)) {
		for (const glob of phase.produces) {
			if (glob.startsWith('<')) {
				problems.push(`missing produce: ${glob} (manual/terminal — cannot auto-validate)`)
				continue
			}
			const matches = matchGlob(ctx.repoRoot, glob).filter(isNonEmptyFile)
			if (matches.length === 0) problems.push(`missing produce: ${glob}`)
		}
	}

	let verdictWarning: string | null = null
	let reviewedRevision: number | undefined
	const reopen = `${phase.gateViewCommand ? `${phase.gateViewCommand} && ` : ''}fabrika builder gate open ${phase.id} --view ${
		phase.gateView ?? phase.id + '.jsx'
	} && fabrika builder gate wait`
	if (phase.gate && !values.force) {
		const daemonUp = await isDaemonRunning()
		if (!daemonUp) {
			problems.push(
				`gate "${phase.id}" cannot be validated offline (daemon down). `
					+ `Open the gate + submit feedback, or pass --force.`,
			)
		} else {
			const review = await consumeGate(ctx.sessionId, phase.id)
			const approved = readApprovals(ctx.repoRoot)?.[phase.id]?.revision
			if (review === null) {
				problems.push(
					`gate "${phase.id}" has no submitted feedback to consume. `
						+ `Run: ${reopen}`,
				)
			} else if (approved !== undefined && review.revision <= approved) {
				// The phase is current again because its files changed; the review it was approved on predates them.
				problems.push(`gate "${phase.id}" was approved at revision ${review.revision}, before its files changed. Re-open it for a new review: ${reopen}`)
			} else {
				reviewedRevision = review.revision
				if (review.verdict !== 'approve') {
					// Gates are advisory: a person may move on over requested changes, but never silently.
					verdictWarning = review.verdict === 'changes'
						? `gate "${phase.id}" was answered "${GATE_CHANGES}"; advancing anyway (gates are advisory). Address the requested changes or re-open the gate.`
						: `gate "${phase.id}" was submitted without a verdict; advancing anyway (gates are advisory).`
				}
			}
		}
	}

	if (verdictWarning) console.error(`[fabrika] warning: ${verdictWarning}`)
	if (phaseIndex(phase.id) >= phaseIndex('skeletons')) {
		for (const warning of skeletonRouteWarnings(ctx.repoRoot)) console.error(`[fabrika] warning: ${warning}`)
	}

	if (problems.length > 0) {
		console.error(`[fabrika] cannot advance from phase ${phase.number}/${PHASE_COUNT} (${phase.id}):`)
		for (const p of problems) console.error(`  - ${p}`)
		return 1
	}

	recordApproval(ctx.repoRoot, state.completed, phase.id, values.force, reviewedRevision)

	const idx = phaseIndex(phase.id)
	const next = idx + 1 < PHASES.length ? PHASES[idx + 1] : null
	if (next) {
		console.log(`OK: phase ${phase.number}/${PHASE_COUNT} (${phase.id}) satisfied.`)
		console.log(`Next -> phase ${next.number}/${PHASE_COUNT} - ${next.title}. Run \`fabrika builder next\`.`)
	} else {
		console.log(`OK: all ${PHASE_COUNT} phases satisfied. Run \`fabrika builder build\`.`)
	}
	return 0
}

/**
 * Approves the gated phase over the inputs it reads now. The first approval of a project that predates the file also
 * records the gated phases it already completed, so they stay complete.
 */
function recordApproval(repoRoot: string, completed: readonly PhaseId[], current: PhaseId, waived: boolean, revision: number | undefined): void {
	const existing = readApprovals(repoRoot)
	const approvals = { ...existing }
	const at = new Date().toISOString()
	const ids = existing === null ? [...completed, current] : [current]
	for (const id of ids) {
		const phase = phaseById(id)
		if (!phase.gate) continue
		const own = id === current ? { ...(waived ? { waived: true } : {}), ...(revision !== undefined ? { revision } : {}) } : {}
		approvals[id] = { at, inputs: phaseInputs(repoRoot, phase), ...own }
	}
	writeApprovals(repoRoot, approvals)
}
