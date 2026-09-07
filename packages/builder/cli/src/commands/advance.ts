import { parseArgs } from 'util'
import { resolveContext } from '../context'
import { consumeFeedback, isDaemonRunning } from '../daemon-client'
import { isNonEmptyFile, matchGlob, producesSatisfied } from '../derive'
import { resolvePhaseState } from '../phase-state'
import { PHASE_COUNT, phaseById, phaseIndex, PHASES } from '../phases'

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

	if (phase.gate && !values.force) {
		const daemonUp = await isDaemonRunning()
		if (!daemonUp) {
			problems.push(
				`gate "${phase.id}" cannot be validated offline (daemon down). `
					+ `Open the gate + submit feedback, or pass --force.`,
			)
		} else {
			const feedback = await consumeFeedback(ctx.sessionId)
			if (feedback === null) {
				problems.push(
					`gate "${phase.id}" has no submitted feedback to consume. `
						+ `Run: fabrika builder gate open ${phase.id} --view ${phase.gateView ?? phase.id + '.jsx'} && fabrika builder gate wait`,
				)
			}
		}
	}

	if (problems.length > 0) {
		console.error(`[fabrika] cannot advance from phase ${phase.number}/${PHASE_COUNT} (${phase.id}):`)
		for (const p of problems) console.error(`  - ${p}`)
		return 1
	}

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
