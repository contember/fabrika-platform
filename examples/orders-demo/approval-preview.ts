// What the console's Approvals page shows for the agent's change, computed by the code Control runs: the example as the
// approved baseline, the example with `billing-export.patch` applied as the candidate. Both are read into access
// snapshots by Control's own reader (`readAccessSnapshot`), compared by `classifyAccess`, and the result is rendered
// by the console's own `AccessChangeView` into `approval-preview.html`, beside this file. It prints every line too.
//
// Run from the repository root: bun examples/orders-demo/approval-preview.ts
// It needs no database, no Docker and no network; `git apply` applies the patch to a temporary copy.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { approvalView } from '../../packages/control-contract/src/index'
import { classifyAccess } from '../../packages/control/src/approval/diff'
import { readAccessSnapshot } from '../../packages/control/src/approval/read'
import { snapshotSurface } from '../../packages/control/src/approval/surface'
import type { ApprovalDto, RunDto } from '../../packages/dashboard/src/lib/api'
import { AccessChangeView } from '../../packages/dashboard/src/routes/approvals/detail'
import { sourceVersionLockfile } from '../../packages/local-stack/src/local-source-fixtures/generate'

const APP_ROOT = join(import.meta.dir, '..', 'orders')
const PATCH = join(import.meta.dir, 'billing-export.patch')
const OUTPUT = join(import.meta.dir, 'approval-preview.html')
const SKIPPED = new Set(['node_modules', 'dist', 'fabrika'])

/** Every file of the application under `root`, by its path relative to it, as a commit holds it. */
function filesOf(root: string): Map<string, string> {
	const files = new Map<string, string>()
	const walk = (directory: string) => {
		for (const name of readdirSync(directory)) {
			if (SKIPPED.has(name) || name.startsWith('.')) continue
			const path = join(directory, name)
			if (statSync(path).isDirectory()) walk(path)
			else files.set(relative(root, path), readFileSync(path, 'utf8'))
		}
	}
	walk(root)
	// The platform build reads the framework release from the application's own bun.lock; inside this repository the
	// example has none, so it gets the one the local stack writes for its fixtures.
	files.set('bun.lock', sourceVersionLockfile(files.get('package.json') ?? '{}'))
	return files
}

const commitOf = (files: ReadonlyMap<string, string>) => ({
	paths: new Set(files.keys()),
	read: async (path: string) => {
		const text = files.get(path)
		if (text === undefined) throw new Error(`no file ${path}`)
		return text
	},
})

/** The example with the agent's patch applied, in a temporary copy. */
function candidateFiles(baseline: ReadonlyMap<string, string>): Map<string, string> {
	const directory = mkdtempSync(join(tmpdir(), 'orders-agent-change-'))
	try {
		for (const [path, text] of baseline) {
			const target = join(directory, path)
			Bun.spawnSync(['mkdir', '-p', join(target, '..')])
			writeFileSync(target, text)
		}
		const applied = Bun.spawnSync(['git', 'apply', '-p3', PATCH], { cwd: directory, stderr: 'pipe' })
		if (applied.exitCode !== 0) throw new Error(`the patch does not apply: ${applied.stderr.toString()}`)
		return filesOf(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

const baselineFiles = filesOf(APP_ROOT)
const baseline = await readAccessSnapshot(commitOf(baselineFiles), '', 'orders')
const candidate = await readAccessSnapshot(commitOf(candidateFiles(baselineFiles)), '', 'orders')
const classification = classifyAccess(baseline, candidate)

const run: RunDto = {
	id: '01a1d000-0000-7000-8000-00000000demo',
	appId: 'orders',
	env: 'prod',
	ref: 'refs/heads/agent/billing-export',
	commitSha: 'a9e7c0de'.padEnd(40, '0'),
	trigger: 'webhook',
	actor: null,
	status: 'awaiting_approval',
	exitCode: null,
	externalRunId: null,
	logKey: null,
	createdAt: Date.now(),
	startedAt: null,
	finishedAt: null,
	cancelRequestedAt: null,
}
const named = new Set(classification.changes.flatMap((change) => (change.subject?.kind === 'endpoint' ? [change.subject.name] : [])))
const approval: ApprovalDto = {
	run,
	outcome: classification.outcome,
	changes: [...classification.changes],
	candidateDigest: 'sha256:candidate',
	baselineDigest: 'sha256:baseline',
	baselineRunId: null,
	protected: true,
	endpoints: snapshotSurface(candidate, named),
	approval: null,
}

console.info(`outcome: ${classification.outcome}`)
for (const change of classification.changes) console.info(`${change.effect.padEnd(8)} ${change.line}`)

const markup = renderToStaticMarkup(createElement(AccessChangeView, { view: approvalView(approval.changes), approval }))
const styles = readFileSync(join(import.meta.dir, '../../packages/dashboard/src/styles.css'), 'utf8')
writeFileSync(
	OUTPUT,
	`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approval: orders · billing export</title>
<style>${styles}</style>
<style>body { padding: 24px 32px; max-width: 1100px; margin: 0 auto; }</style>
</head>
<body>
<p class="hint">Preview of the console's Approvals page for the agent's change to <code>orders</code> on <code>prod</code>,
rendered by the console's own component from Control's classification. Outcome: <strong>${classification.outcome}</strong>.</p>
${markup}
</body>
</html>
`,
)
console.info(`wrote ${relative(process.cwd(), OUTPUT)}`)
