import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseArgs } from 'util'
import { resolveStackPointer } from '../catalog'
import { resolveContext } from '../context'
import { induceIssues, renderIssue } from '../induce'
import { readSkeletons } from '../skeletons'

export async function cmdInduce(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			dir: { type: 'string' },
			session: { type: 'string' },
			force: { type: 'boolean', default: false },
		},
		allowPositionals: true,
	})

	const ctx = resolveContext({ dir: values.dir, session: values.session })
	if (!ctx.initialized) {
		console.error(`[fabrika] no .fabrika/ found at or above ${ctx.repoRoot}. Run \`fabrika builder init\` first.`)
		return 1
	}

	const testsBrowserDir = join(ctx.repoRoot, 'tests', 'browser')
	const skeletons = readSkeletons(testsBrowserDir)
	if (skeletons.length === 0) {
		console.error(
			`[fabrika] no opice skeletons in ${testsBrowserDir}. `
				+ `Author them in phase 6 (skeletons) first.`,
		)
		return 1
	}

	const issues = induceIssues(skeletons, { stack: resolveStackPointer(ctx.profile) ?? undefined })
	const issuesDir = join(ctx.fabrikaDir, 'issues')
	mkdirSync(issuesDir, { recursive: true })

	let written = 0
	let skipped = 0
	for (const issue of issues) {
		const path = join(issuesDir, `${issue.id}.md`)
		if (existsSync(path) && !values.force) {
			skipped++
			continue
		}
		writeFileSync(path, renderIssue(issue))
		written++
	}

	const foundation = issues.filter((i) => i.kind === 'foundation').length
	const feature = issues.filter((i) => i.kind === 'feature').length
	console.log(
		`[fabrika] induced ${issues.length} issue(s) from ${skeletons.length} skeleton(s): `
			+ `${foundation} foundation + ${feature} feature.`,
	)
	console.log(`[fabrika] wrote ${written}, skipped ${skipped} existing (use --force to overwrite).`)
	console.log(`[fabrika] → .fabrika/issues/  · next: fabrika builder advance && fabrika builder next  (build)`)
	return 0
}
