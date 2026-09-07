import { join } from 'path'
import { parseArgs } from 'util'
import { type BuildPlan, planBuild, readBoard, record } from '../build-status'
import { resolveStackPointer } from '../catalog'
import { resolveContext } from '../context'
import { postBuildEvent } from '../daemon-client'
import { type Issue, readIssues } from '../issues'

export async function cmdBuild(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			reason: { type: 'string' },
			issue: { type: 'string' },
			dir: { type: 'string' },
			session: { type: 'string' },
			assisted: { type: 'boolean', default: false },
		},
		allowPositionals: true,
	})

	const sub = positionals[0] ?? 'next'
	const idArg = positionals[1] ?? values.issue

	const ctx = resolveContext({ dir: values.dir, session: values.session })
	if (!ctx.initialized) {
		console.error(`[fabrika] no .fabrika/ found at or above ${ctx.repoRoot}. Run \`fabrika builder init\` first.`)
		return 1
	}

	const issues = readIssues(ctx.fabrikaDir)
	if (issues.length === 0) {
		console.error(
			`[fabrika] no issues in ${ctx.fabrikaDir}/issues/. Run \`fabrika builder induce\` (phase 7) first.`,
		)
		return 1
	}
	const byId = (id: string) => issues.find((i) => i.id === id) ?? null

	switch (sub) {
		case 'status':
			printBoard(planBuild(issues, readBoard(ctx.fabrikaDir)))
			return 0

		case 'done': {
			if (!idArg || !byId(idArg)) {
				console.error(`[fabrika] build done <ISSUE-ID> — unknown or missing issue id.`)
				return 1
			}
			record(ctx.fabrikaDir, idArg, 'done', undefined, new Date().toISOString())
			await postBuildEvent({ issue: idArg, status: 'passed', message: 'issue green (bun test passed)' })
			console.log(`[fabrika] ✓ ${idArg} marked done.`)
			return await reportProgress(issues, ctx.fabrikaDir)
		}

		case 'block': {
			if (!idArg || !byId(idArg)) {
				console.error(`[fabrika] build block <ISSUE-ID> --reason "…" — unknown or missing issue id.`)
				return 1
			}
			const reason = values.reason ?? 'blocked (no reason given)'
			record(ctx.fabrikaDir, idArg, 'blocked', reason, new Date().toISOString())
			await postBuildEvent({ issue: idArg, status: 'blocked', message: reason })
			console.log(`[fabrika] ⚠ ${idArg} blocked: ${reason}`)
			console.log(`[fabrika] continuing to independent issues; collect blocked at final review.`)
			return await reportProgress(issues, ctx.fabrikaDir)
		}

		case 'next':
		default: {
			if (values.issue && byId(values.issue)) {
				await postBuildEvent({ issue: values.issue, status: 'running', message: 'building (re-selected)' })
				process.stdout.write('\n' + renderBuildPacket(byId(values.issue)!, ctx.repoRoot, ctx.profile))
				return 0
			}
			return await emitBrief(issues, ctx.fabrikaDir, ctx.repoRoot, ctx.profile)
		}
	}
}

async function emitBrief(
	issues: Issue[],
	fabrikaDir: string,
	repoRoot: string,
	profile: string,
): Promise<number> {
	const plan = planBuild(issues, readBoard(fabrikaDir))
	printSummary(plan)

	if (plan.complete) {
		return await reportComplete(plan, issues.length)
	}

	await postBuildEvent({
		status: 'info',
		message: `build: ${plan.done.length}/${issues.length} done, ${plan.ready.length} ready`,
	})
	process.stdout.write('\n' + renderOrchestrationBrief(plan, repoRoot, profile))
	return 0
}

async function reportProgress(issues: Issue[], fabrikaDir: string): Promise<number> {
	const plan = planBuild(issues, readBoard(fabrikaDir))
	if (plan.complete) return await reportComplete(plan, issues.length)
	printBoard(plan)
	if (!plan.next && plan.waiting.length) {
		console.error(`\n[fabrika] nothing buildable: ${plan.waiting.length} waiting on blocked deps (see final review).`)
	}
	return 0
}

async function reportComplete(plan: BuildPlan, total: number): Promise<number> {
	await postBuildEvent({ status: 'info', message: `build complete: ${plan.done.length}/${total} green` })
	console.log(
		`\n[fabrika] ✓ build complete — ${plan.done.length}/${total} issues green`
			+ (plan.blocked.length ? `, ${plan.blocked.length} blocked (see final review).` : '.'),
	)
	if (plan.blocked.length) {
		console.log(`\nBlocked (final review):`)
		for (const b of plan.blocked) console.log(`  ⚠ ${b.id}  ${b.goal}`)
	}
	return 0
}

function printSummary(plan: BuildPlan): void {
	const total = plan.done.length + plan.blocked.length + plan.ready.length + plan.waiting.length
	console.log(
		`build: ${plan.done.length}/${total} done · ${plan.ready.length} ready · `
			+ `${plan.waiting.length} waiting · ${plan.blocked.length} blocked`,
	)
}

function printBoard(plan: BuildPlan): void {
	printSummary(plan)
	const line = (label: string, xs: Issue[]) => xs.length && console.log(`\n${label}:\n` + xs.map((i) => `  ${i.id}  ${i.goal}`).join('\n'))
	line('✓ done', plan.done)
	line('→ ready', plan.ready)
	line('… waiting', plan.waiting)
	line('⚠ blocked', plan.blocked)
}

function stackBriefLines(profile: string): string[] {
	const p = resolveStackPointer(profile)
	if (!p) return []
	if (!p.stackFileExists) {
		return [
			`Stack:       ${profile} — preset NOT found; pick one of ${join(p.root, 'stacks')}/*.md (decisions under ${p.decisionsDir}/)`,
		]
	}
	return [
		`Stack:       ${profile} -> ${p.stackFile}`,
		`             resolve its \`decisions:\` ids under ${p.decisionsDir}/ and read the live \`sources\` they pin`,
	]
}

function renderOrchestrationBrief(plan: BuildPlan, repoRoot: string, profile: string): string {
	const marker = new Map<string, string>()
	for (const i of plan.done) marker.set(i.id, '✓')
	for (const i of plan.blocked) marker.set(i.id, '⚠')
	for (const i of plan.ready) marker.set(i.id, '→')
	for (const i of plan.waiting) marker.set(i.id, '…')
	const all = [...plan.done, ...plan.ready, ...plan.waiting, ...plan.blocked].sort((a, b) => a.id.localeCompare(b.id))
	const doneIds = new Set(plan.done.map((i) => i.id))

	const dag = all.map((i) => {
		const deps = i.dependsOn.length ? `  deps: ${i.dependsOn.join(', ')}` : ''
		const note = marker.get(i.id) === '…'
			? `  (waiting on ${i.dependsOn.filter((d) => !doneIds.has(d)).join(', ')})`
			: ''
		return `  ${marker.get(i.id) ?? '?'} ${i.id}  ${i.goal}${deps}${note}`
	})

	return [
		`## Build — ${all.length} issues`,
		`Apply the bundled **agents/build-orchestrator.md** playbook in the MAIN session.`,
		`Do not spawn a nested orchestrator. SUPERVISE and fan out one direct`,
		`implementer subagent per issue (use the fabrika-implementer role; worktree-isolated`,
		`where they run in parallel). Do NOT hand-code the whole DAG yourself.`,
		``,
		`Repo:  ${repoRoot}`,
		``,
		`Issue DAG (foundation first; build independents in parallel):`,
		...dag,
		``,
		`Per issue:   implement → opice-author (selectors vs the running app) → \`bun test\` green.`,
		`Acceptance:  the issue's \`satisfies\` scenarios + FROZEN invariants must pass.`,
		`             Never weaken an invariant statement to go green — adversarially verify it.`,
		...stackBriefLines(profile),
		`Scaffold:    NO templates — read the stack preset + its decisions + the live sources`,
		`             they point to, and scaffold from current APIs (your memory is likely stale).`,
		`Record:      fabrika builder build done <ID>   |   fabrika builder build block <ID> --reason "…"`,
		`             (both write status.json + stream a BuildEvent to the dashboard)`,
		`Detail:      fabrika builder build --issue <ID>   (re-emit one issue's full packet)`,
	].join('\n') + '\n'
}

function renderBuildPacket(issue: Issue, repoRoot: string, profile: string): string {
	const lines: string[] = []
	lines.push(`## Build issue ${issue.id}`)
	lines.push(`Goal:      ${issue.goal || '(no goal recorded)'}`)
	lines.push(`Satisfies: ${issue.satisfies.length ? issue.satisfies.join(', ') : '(none)'}`)
	lines.push(`Depends:   ${issue.dependsOn.length ? issue.dependsOn.join(', ') : '(none)'}`)
	lines.push(`Touches:   ${issue.touches.length ? issue.touches.join(', ') : '(none)'}`)
	const sp = resolveStackPointer(profile)
	if (sp?.stackFileExists) {
		lines.push(`Stack:     ${profile} -> ${sp.stackFile}  (decisions under ${sp.decisionsDir}/)`)
	}
	lines.push(`Pipeline:  implement -> opice-author (selectors vs running app) -> bun test (steps + invariants)`)
	lines.push(`Done when: green \`bun test\` for the satisfied scenarios/invariants.`)
	lines.push(`Repo:      ${repoRoot}`)
	lines.push(``)
	lines.push(`After green:  fabrika builder build done ${issue.id}    (records it + emits the next packet)`)
	lines.push(`If stuck:     fabrika builder build block ${issue.id} --reason "…"   (escalate, continue)`)
	return lines.join('\n') + '\n'
}
