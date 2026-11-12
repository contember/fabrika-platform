import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { parseArgs } from 'util'
import { GATE_CHANGES } from '../../../shared/gate'
import { BUILD_REVIEW_PATH, describeEvidence, renderBuildReview } from '../build-review'
import { type BuildEvidence, type BuildPlan, planBuild, readBoard, record } from '../build-status'
import { resolveStackPointer, unsupportedProfileNote } from '../catalog'
import { resolveContext } from '../context'
import { consumeGate, postBuildEvent } from '../daemon-client'
import { ensureDaemon } from '../daemon-lifecycle'
import { describePair, DESIGN_GATE, DESIGN_PATH, failingPairs, readDesignContrast, summarizeContrast } from '../design-review'
import { type Issue, readIssues } from '../issues'
import { describeVerification, gitState, runVerification, type Verification } from '../verify'

export async function cmdBuild(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			reason: { type: 'string' },
			verify: { type: 'string' },
			issue: { type: 'string' },
			dir: { type: 'string' },
			session: { type: 'string' },
			assisted: { type: 'boolean', default: false },
			'waive-contrast': { type: 'boolean', default: false },
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
			`[fabrika] no issues in ${ctx.fabrikaDir}/issues/. Run \`fabrika builder induce\` (phase 6) first.`,
		)
		return 1
	}
	const byId = (id: string) => issues.find((i) => i.id === id) ?? null

	switch (sub) {
		case 'status':
			printBoard(planBuild(issues, readBoard(ctx.fabrikaDir)))
			return 0

		case 'done': {
			const issue = idArg ? byId(idArg) : null
			if (!issue) {
				console.error(`[fabrika] build done <ISSUE-ID> — unknown or missing issue id.`)
				return 1
			}
			if (issue.gate) {
				if (values.verify || issue.verify.length > 0) {
					console.error(`[fabrika] ${issue.id} is proved by its "${issue.gate}" review gate; it takes no --verify or verify files.`)
					return 1
				}
				const check = issue.gate === DESIGN_GATE ? checkDesignContrast(issue, ctx.repoRoot, values['waive-contrast']) : ''
				if (check === null) return 1
				return await recordGateReview(issue, issue.gate, check, ctx.sessionId, ctx.repoRoot, ctx.fabrikaDir, issues)
			}
			if (values.verify && issue.verify.length > 0) {
				console.error(`[fabrika] ${issue.id} is proved by ${issue.verify.join(', ')}; --verify is only for issues that name no acceptance file.`)
				return 1
			}
			const verification: Verification | null = values.verify
				? { kind: 'command', command: values.verify }
				: issue.verify.length > 0
				? { kind: 'files', files: issue.verify }
				: null
			if (!verification) {
				console.error(
					`[fabrika] ${issue.id} names no acceptance file. Pass the check that proves it: `
						+ `fabrika builder build done ${issue.id} --verify "<command>"`,
				)
				return 1
			}
			console.log(`[fabrika] ${issue.id}: running ${describeVerification(verification)}`)
			const evidence = await runVerification(ctx.repoRoot, verification)
			if (evidence.exitCode !== 0) {
				await postBuildEvent({ issue: issue.id, status: 'failed', message: `check failed: ${describeEvidence(evidence)}` })
				console.error(`[fabrika] ✗ ${issue.id} not marked done: \`${evidence.command}\` exited ${evidence.exitCode}.`)
				return 1
			}
			record(ctx.fabrikaDir, issue.id, 'done', undefined, evidence.at, evidence)
			await postBuildEvent({ issue: issue.id, status: 'passed', message: `check passed: ${describeEvidence(evidence)}` })
			console.log(`[fabrika] ✓ ${issue.id} marked done (${describeEvidence(evidence)}).`)
			return await reportProgress(issues, ctx.fabrikaDir)
		}

		case 'review': {
			const path = join(ctx.repoRoot, BUILD_REVIEW_PATH)
			mkdirSync(dirname(path), { recursive: true })
			writeFileSync(path, renderBuildReview(issues, readBoard(ctx.fabrikaDir), new Date()))
			console.log(path)
			return 0
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

/**
 * The design checkpoint's deterministic half: the theme override's contrast. Unlike the advisory verdict, a pair below
 * AA refuses `done` until the stylesheet is fixed or the reviewer waives it. Returns the evidence suffix, or null.
 */
function checkDesignContrast(issue: Issue, repoRoot: string, waive: boolean | undefined): string | null {
	const contrast = readDesignContrast(repoRoot)
	const failing = failingPairs(contrast)
	const refused = contrast.kind === 'invalid' || failing.length > 0
	if (refused && !waive) {
		console.error(`[fabrika] ${issue.id} not marked done: ${summarizeContrast(contrast)}.`)
		for (const pair of failing) console.error(`[fabrika]   ${describePair(pair)}`)
		console.error(
			contrast.kind === 'invalid'
				? `[fabrika] Name the theme stylesheet in ${DESIGN_PATH} (front matter \`stylesheet: <path>\`), then run \`fabrika builder build done ${issue.id}\` again.`
				: `[fabrika] Raise these pairs in the stylesheet and re-open the gate, or pass --waive-contrast when the reviewer accepts them.`,
		)
		return null
	}
	if (contrast.kind === 'checked') {
		for (const r of contrast.results) {
			if (r.status === 'unchecked') console.error(`[fabrika] warning: contrast not checked for ${r.mode} ${r.fg} on ${r.bg}: ${r.note ?? ''}`)
		}
	}
	return ` · ${summarizeContrast(contrast)}${refused ? ' (waived)' : ''}`
}

/** An issue whose check is a review gate: record the gate's consumed verdict. Gates are advisory, so "changes" warns. */
async function recordGateReview(
	issue: Issue,
	gate: string,
	/** Appended to the evidence: what a deterministic check beside the gate found. */
	checked: string,
	sessionId: string,
	repoRoot: string,
	fabrikaDir: string,
	issues: Issue[],
): Promise<number> {
	await ensureDaemon({ quiet: true })
	const review = await consumeGate(sessionId, gate)
	if (!review) {
		console.error(
			`[fabrika] ${issue.id} not marked done: the "${gate}" gate has no submitted review (or the daemon is down). `
				+ `Open it, have it reviewed, then run \`fabrika builder build done ${issue.id}\` again.`,
		)
		return 1
	}
	const evidence: BuildEvidence = {
		command: `${gate} gate review, revision ${review.revision}${checked}`,
		exitCode: 0,
		durationMs: 0,
		at: new Date().toISOString(),
		...gitState(repoRoot),
		verdict: review.verdict,
	}
	if (review.verdict !== 'approve') {
		console.error(
			`[fabrika] warning: the "${gate}" gate was ${
				review.verdict === 'changes' ? `answered "${GATE_CHANGES}"` : 'submitted without a verdict'
			}; recording ${issue.id} anyway (gates are advisory).`,
		)
	}
	record(fabrikaDir, issue.id, 'done', undefined, evidence.at, evidence)
	await postBuildEvent({ issue: issue.id, status: 'passed', message: `reviewed: ${describeEvidence(evidence)}` })
	console.log(`[fabrika] ✓ ${issue.id} marked done (${describeEvidence(evidence)}).`)
	return await reportProgress(issues, fabrikaDir)
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
		...(p.support === 'unsupported' ? [`             warning: ${unsupportedProfileNote(profile)}`] : []),
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
		const gate = i.gate ? `  [${i.gate} gate: main session, needs the human]` : ''
		return `  ${marker.get(i.id) ?? '?'} ${i.id}  ${i.goal}${deps}${note}${gate}`
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
		`Record:      fabrika builder build done <ID> [--verify "<command>"]   |   fabrika builder build block <ID> --reason "…"`,
		`             (done RUNS the issue's check and refuses on red; both write status.json + stream a BuildEvent)`,
		`Review:      fabrika builder build review && fabrika builder gate open build --view ${BUILD_REVIEW_PATH}`,
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
		if (sp.support === 'unsupported') lines.push(`           warning: ${unsupportedProfileNote(profile)}`)
	}
	lines.push(
		issue.gate
			? `Pipeline:  follow the steps in ${issue.path} in the MAIN session; the "${issue.gate}" gate needs the human`
			: `Pipeline:  implement -> opice-author (selectors vs running app) -> bun test (steps + invariants)`,
	)
	lines.push(
		issue.gate
			? `Check:     the "${issue.gate}" review gate (build done records its verdict)`
			: issue.verify.length > 0
			? `Check:     bun test ${issue.verify.join(' ')}   (build done runs it)`
			: `Check:     none recorded — pass the command that proves this issue: build done ${issue.id} --verify "<command>"`,
	)
	lines.push(`Repo:      ${repoRoot}`)
	lines.push(``)
	lines.push(`After green:  fabrika builder build done ${issue.id}    (runs the check, records it, emits the next packet)`)
	lines.push(`If stuck:     fabrika builder build block ${issue.id} --reason "…"   (escalate, continue)`)
	return lines.join('\n') + '\n'
}
