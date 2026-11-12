import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { parseArgs } from 'util'
import { resolveContext } from '../context'
import {
	describePair,
	DESIGN_PATH,
	DESIGN_REVIEW_PATH,
	failingPairs,
	readDesignContrast,
	renderDesignReview,
	summarizeContrast,
} from '../design-review'
import { readSkeletons } from '../skeletons'

export async function cmdDesign(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { dir: { type: 'string' }, session: { type: 'string' } },
		allowPositionals: true,
	})
	if (positionals[0] !== 'review') {
		console.error('[fabrika] usage: fabrika builder design review')
		return 1
	}
	const ctx = resolveContext({ dir: values.dir, session: values.session })
	if (!ctx.initialized) {
		console.error(`[fabrika] no .fabrika/ found at or above ${ctx.repoRoot}. Run \`fabrika builder init\` first.`)
		return 1
	}
	const contrast = readDesignContrast(ctx.repoRoot)
	console.error(`[fabrika] ${summarizeContrast(contrast)}`)
	for (const pair of failingPairs(contrast)) console.error(`[fabrika]   below AA: ${describePair(pair)}`)
	const urls = [...new Set(readSkeletons(join(ctx.repoRoot, 'tests', 'browser')).flatMap((s) => (s.url ? [s.url] : [])))]
	const path = join(ctx.repoRoot, DESIGN_REVIEW_PATH)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, renderDesignReview(contrast, urls, existsSync(join(ctx.repoRoot, DESIGN_PATH)), new Date()))
	console.log(path)
	return 0
}
