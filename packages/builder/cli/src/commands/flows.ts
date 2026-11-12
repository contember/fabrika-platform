import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { parseArgs } from 'util'
import { resolveContext } from '../context'
import { FLOWS_REVIEW_PATH, readFlows, renderFlowsReview } from '../flows'

export async function cmdFlows(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { dir: { type: 'string' }, session: { type: 'string' } },
		allowPositionals: true,
	})
	if (positionals[0] !== 'review') {
		console.error('[fabrika] usage: fabrika builder flows review')
		return 1
	}
	const ctx = resolveContext({ dir: values.dir, session: values.session })
	if (!ctx.initialized) {
		console.error(`[fabrika] no .fabrika/ found at or above ${ctx.repoRoot}. Run \`fabrika builder init\` first.`)
		return 1
	}
	const flows = readFlows(ctx.repoRoot)
	// The map is advisory, like every gate: problems are shown in the view and here, and never stop it.
	for (const flow of flows) {
		for (const problem of flow.problems) console.error(`[fabrika] warning: ${flow.path}: ${problem}`)
	}
	const path = join(ctx.repoRoot, FLOWS_REVIEW_PATH)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, renderFlowsReview(flows, new Date()))
	console.log(path)
	return 0
}
