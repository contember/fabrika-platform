import { parseArgs } from 'util'
import { resolveContext } from '../context'
import { packetJson, renderPacket } from '../packet'
import { resolvePhaseState } from '../phase-state'

export async function cmdNext(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			json: { type: 'boolean', default: false },
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

	const { state, source } = await resolvePhaseState(ctx.repoRoot, ctx.fabrikaDir, ctx.sessionId)

	if (values.json) {
		console.log(JSON.stringify({ ...packetJson(state, { profile: ctx.profile }), source }))
	} else {
		process.stdout.write(renderPacket(state, { profile: ctx.profile }))
	}
	return 0
}
