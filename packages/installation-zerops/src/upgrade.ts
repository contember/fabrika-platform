// `fabrika platform upgrade --provider=zerops --to=<tag>` — roll one installation onto a newer release.
//
// ── Why this is a command and not a paragraph in a README ─────────────────────────────────────────
//
// [ADR-0025](../../../docs/decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)
// puts the deploying pipeline in a repository the OPERATOR owns, pinned to a published fabrika tag in
// `fabrika.ref`. Rolling forward is therefore five steps in someone else's checkout — edit the pin,
// commit, push, find the run the push started, watch it — and every one of them is a place to get the
// spelling wrong. `platform init` already knows the repository, the checkout directory and the tag
// rule; this command is those five steps with that knowledge applied.
//
// ── What it refuses, and why each refusal is here rather than in the workflow ─────────────────────
//
//   • A ref that is not a published tag — `assertPinnedTag` in `upgrade-options.ts`, before any
//     network call. The generated workflow refuses one again at run time, but only after a queue and a
//     checkout (ADR-0025's two gates).
//   • A tag the public repository does not carry. The release job pushes the tag last, so "I tagged it
//     a minute ago" is exactly the case a local check cannot see. A tag lookup that FAILED is a third
//     answer, never "no such tag": reporting a rate limit as a missing tag sends the operator to look
//     at the wrong repository.
//   • A directory that is not a checkout, and a branch the workflow does not trigger on.
//   • A dirty sidecar tree. The commit stages `fabrika.ref` alone, so anything else the operator was
//     part-way through would be left behind on a branch that just deployed.
//   • A pin already equal to `--to` — but only when it is PUSHED. A pin committed and not pushed is
//     the state a failed push leaves behind, and "already pins it" would be a lie there: the push that
//     IS the trigger never happened, so nothing was deployed.
//
// ── The commit carries no `[skip ci]`, deliberately ──────────────────────────────────────────────
//
// Both scaffold commits do (`@fabrika/installation-init`'s `scaffold.ts`), because a scaffold push must
// not deploy before the Environment holding the credentials exists. Here the push IS the trigger: the
// generated workflow runs on a push touching `fabrika.ref`.

import { capture, hasGhCli, run as runStep } from '@fabrika/installation-init'
import { defaultSleep, type Sleeper } from '@fabrika/provider-zerops'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { consoleDeployLog, type DeployLog } from './log'
import { FABRIKA_REF_FILE, readPinnedTag } from './sidecar'
import type { PlatformUpgradeInput } from './upgrade-options'

/** The public repository whose tags an installation may be pinned to. */
export const FABRIKA_REPOSITORY = 'contember/fabrika-platform'

/** The workflow `platform init` generates, and the only one a roll may be watching. */
export const SIDECAR_WORKFLOW_FILE = 'platform.yml'

/** The branch the generated workflow triggers on (`push: branches: [main]`). */
export const SIDECAR_BRANCH = 'main'

/** The `<owner>/fabrika-zerops-<installation>` naming `platform init` follows, read backwards. */
const SIDECAR_REPO_PREFIX = 'fabrika-zerops-'

/** How often the pushed commit's workflow run is looked for. */
const RUN_POLL_INTERVAL_MS = 5_000
/** GitHub registers a run a few seconds after the push; bounded so a run that never appears is an error. */
const RUN_APPEARS_ATTEMPTS = 12

/**
 * What the public repository answered about a tag.
 *
 * THREE answers, not two. `gh` exits non-zero for a rate limit, an expired token and an unreachable
 * network exactly as it would for a repository that does not exist, and reporting any of those as
 * `missing` would send an operator to check a tag that is in fact already published.
 */
export type TagLookup =
	| { readonly state: 'published' }
	| { readonly state: 'missing' }
	| { readonly state: 'unavailable'; readonly reason: string }

/** One workflow run, as `gh run list` describes it. */
export interface UpgradeRun {
	readonly id: string
	readonly url: string
	/** `queued`, `in_progress`, `completed` — reported so the operator knows why nothing moves yet. */
	readonly status: string
}

/** Where the sidecar's branch stands relative to what the pipeline actually watches. */
export interface SidecarBranch {
	/** The checked-out branch, or `HEAD` when detached. */
	readonly name: string
	/** Commits the upstream does not have; `undefined` when the branch tracks nothing. */
	readonly ahead: number | undefined
}

/** Everything `runUpgrade` does outside its own process. Injected so the flow can be driven without git or gh. */
export interface UpgradeEffects {
	/** Is `gh` installed AND logged in? Every other effect here needs both, so it is asked once, first. */
	hasGh(): Promise<boolean>
	/** Does the public repository carry this tag? The one thing a local check cannot answer. */
	verifyTag(tag: string): Promise<TagLookup>
	/** Clone `<owner>/<name>` into a fresh directory and return it. */
	cloneSidecar(repo: string): Promise<string>
	/** The `<owner>/<name>` this checkout pushes to — also the repository the run is looked for in. */
	describeCheckout(dir: string): Promise<string>
	/** Does the checkout carry uncommitted changes to TRACKED files? Untracked ones are not staged here. */
	isDirty(dir: string): Promise<boolean>
	/** Which branch the checkout is on, and how far ahead of its upstream. */
	readBranch(dir: string): Promise<SidecarBranch>
	/** Stage `files`, commit them with `message`, and return the resulting commit SHA. */
	commit(input: { readonly dir: string; readonly files: readonly string[]; readonly message: string }): Promise<string>
	push(dir: string): Promise<void>
	/** The run GitHub registered for `sha`, or undefined while it has not appeared yet. */
	findRun(input: { readonly repo: string; readonly sha: string }): Promise<UpgradeRun | undefined>
	/** Follow a run to its conclusion. Throws when it ends in anything but success. */
	watchRun(input: { readonly repo: string; readonly runId: string }): Promise<void>
}

export interface UpgradeCollaborators {
	readonly log: DeployLog
	readonly effects: UpgradeEffects
	readonly sleep: Sleeper
	readonly signal: AbortSignal
}

/** The fixed commit subject. Fixed so `git log` in a sidecar reads as the installation's release history. */
export const upgradeCommitMessage = (installation: string, tag: string): string => `chore: roll ${installation} forward to fabrika ${tag}`

/**
 * What to call this installation in the commit subject.
 *
 * The operator's own name when they gave one; otherwise the sidecar repository's name with the
 * `fabrika-zerops-` prefix `platform init` adds stripped back off, so `--sidecar=<owner>/<name>` alone
 * still writes the subject a named run would have.
 */
const installationLabel = (input: PlatformUpgradeInput, repo: string): string => {
	if (input.installation !== undefined) {
		return input.installation
	}
	const name = repo.slice(repo.indexOf('/') + 1)
	return name.startsWith(SIDECAR_REPO_PREFIX) ? name.slice(SIDECAR_REPO_PREFIX.length) : name
}

/** Both ways of pointing this command at a sidecar, named together because a wrong path is the usual mistake. */
const BOTH_WAYS = 'name the installation to use ./fabrika-zerops-<installation>, point at a checkout with --sidecar=<path>, '
	+ 'or let this command clone one with --sidecar=<owner>/<name>'

const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new Error('the fabrika upgrade was cancelled')
	}
}

/**
 * A local checkout, checked before the first shell-out.
 *
 * `Bun.spawn` on a cwd that does not exist fails with a raw ENOENT naming neither the flag that
 * supplied it nor the alternative — the same reason `scaffold.ts` probes for `.git` itself.
 */
const assertCheckout = (dir: string): void => {
	if (!existsSync(dir)) {
		throw new Error(`${dir} does not exist — ${BOTH_WAYS}`)
	}
	if (!existsSync(resolve(dir, '.git'))) {
		throw new Error(`${dir} is not a git checkout — ${BOTH_WAYS}`)
	}
}

/** Wait for the run the push started. Bounded: a push that started none is an error naming the repository. */
const awaitRun = async (repo: string, sha: string, { effects, sleep, signal }: UpgradeCollaborators): Promise<UpgradeRun> => {
	for (let attempt = 0;; attempt += 1) {
		assertRunning(signal)
		const run = await effects.findRun({ repo, sha })
		if (run !== undefined) {
			return run
		}
		if (attempt >= RUN_APPEARS_ATTEMPTS) {
			throw new Error(
				`the pin was pushed to ${repo} but no ${SIDECAR_WORKFLOW_FILE} run appeared for ${sha} on ${SIDECAR_BRANCH} — `
					+ "check the repository's Actions tab",
			)
		}
		await sleep(RUN_POLL_INTERVAL_MS, signal)
	}
}

/** The tag check, with the failure case kept apart from the answer. */
const assertTagPublished = async (tag: string, { log, effects }: UpgradeCollaborators): Promise<void> => {
	const lookup = await effects.verifyTag(tag)
	if (lookup.state === 'unavailable') {
		throw new Error(`${FABRIKA_REPOSITORY} could not be asked whether it carries \`${tag}\`: ${lookup.reason}`)
	}
	if (lookup.state === 'missing') {
		throw new Error(
			`${FABRIKA_REPOSITORY} has no tag \`${tag}\`. A release publishes its packages before it pushes the tag, `
				+ 'so a tag that exists locally is not yet one an installation can be pinned to',
		)
	}
	log.info(`${tag} is published`)
}

/**
 * The branch, checked against what the pipeline actually watches, and against a push that never landed.
 *
 * Returns how many commits are waiting to be pushed, because the "already pins it" refusal below reads
 * differently depending on that number.
 */
const checkedBranch = async (dir: string, repo: string, { log, effects }: UpgradeCollaborators): Promise<number> => {
	const branch = await effects.readBranch(dir)
	if (branch.name !== SIDECAR_BRANCH) {
		throw new Error(
			`${dir} is on \`${branch.name}\`, not \`${SIDECAR_BRANCH}\` — the generated workflow triggers on `
				+ `\`push: branches: [${SIDECAR_BRANCH}]\`, so a push from here would deploy nothing`,
		)
	}
	if (branch.ahead === undefined) {
		throw new Error(`${dir} tracks no upstream branch — run \`git -C ${dir} push -u origin ${SIDECAR_BRANCH}\` once, then re-run this`)
	}
	if (branch.ahead > 0) {
		log.warn(`${repo}: ${branch.ahead} commit(s) here have not been pushed yet — this roll's push carries them too`)
	}
	return branch.ahead
}

/**
 * Roll one installation's sidecar onto a published fabrika tag and follow the deploy it triggers.
 *
 * Nothing is written until every refusal has been passed, so a run that stops early leaves the sidecar
 * exactly as it was — and once the push has landed the roll is under way whether or not this process
 * survives, which is why the run URL is printed before anything is watched.
 */
export const runUpgrade = async (input: PlatformUpgradeInput, collaborators: UpgradeCollaborators): Promise<void> => {
	const { log, effects, signal } = collaborators
	assertRunning(signal)

	if (!(await effects.hasGh())) {
		throw new Error('`gh` (GitHub CLI) is required — install it and run `gh auth login`.')
	}

	log.step(`Check that ${FABRIKA_REPOSITORY} carries ${input.to}`)
	await assertTagPublished(input.to, collaborators)

	log.step('Open the sidecar repository')
	const dir = input.sidecar.kind === 'repo' ? await effects.cloneSidecar(input.sidecar.repo) : resolve(input.sidecar.dir)
	if (input.sidecar.kind === 'repo') {
		log.info(`cloned ${input.sidecar.repo} into ${dir}`)
	}
	assertCheckout(dir)
	const repo = await effects.describeCheckout(dir)
	if (await effects.isDirty(dir)) {
		throw new Error(
			`${dir} has uncommitted changes to tracked files — this command commits \`${FABRIKA_REF_FILE}\` alone, so commit or `
				+ 'discard them first (untracked files are left alone)',
		)
	}
	const unpushed = await checkedBranch(dir, repo, collaborators)
	const pinned = await readPinnedTag(dir)
	if (pinned === '') {
		throw new Error(`${dir} has no \`${FABRIKA_REF_FILE}\` — it is not a fabrika sidecar checkout`)
	}
	if (pinned === input.to && unpushed > 0) {
		// What a failed push leaves behind. "Already pins it" would be true of the working tree and false
		// of the installation, which is the one that matters.
		throw new Error(
			`${dir} already pins ${input.to} in a commit that was never pushed, so nothing was deployed — `
				+ `run \`git -C ${dir} push\` to trigger the roll`,
		)
	}
	if (pinned === input.to) {
		throw new Error(`${repo} already pins ${input.to}. Nothing to push, and the push is what triggers the deploy`)
	}
	const message = upgradeCommitMessage(installationLabel(input, repo), input.to)
	log.info(`${repo}: ${pinned} → ${input.to}`)

	if (input.dryRun) {
		log.step('Dry run complete — nothing was written')
		log.info(`would write \`${input.to}\` to ${FABRIKA_REF_FILE} and commit it as \`${message}\``)
		return
	}

	log.step('Roll the pin forward')
	await Bun.write(resolve(dir, FABRIKA_REF_FILE), `${input.to}\n`)
	const sha = await effects.commit({ dir, files: [FABRIKA_REF_FILE], message })
	await effects.push(dir)
	log.info(`pushed ${sha}`)

	log.step('Follow the deploy')
	const run = await awaitRun(repo, sha, collaborators)
	// Printed BEFORE the watch: the roll is under way whether or not this terminal stays open, and the
	// generated workflow queues rather than cancels, so a run behind an earlier roll can sit here a while.
	log.info(run.url)
	log.info(`run ${run.id} is ${run.status} — the sidecar workflow queues behind an earlier roll rather than cancelling it`)
	await effects.watchRun({ repo, runId: run.id })
	log.step(`${repo} is running fabrika ${input.to}`)
}

/**
 * Is `<tag>` among the refs `git/matching-refs/tags/<tag>` answered with?
 *
 * That endpoint is a PREFIX match — `tags/v0.0.2` answers with `v0.0.2`, `v0.0.20`, `v0.0.21` and the
 * rest — so membership is decided by an exact `refs/tags/<tag>` comparison and never by the list being
 * non-empty. It is used INSTEAD of `git/ref/tags/<tag>` precisely because a missing tag is a 200 with
 * an empty list there: every non-zero exit is then a real failure rather than an answer.
 */
const carriesTag = (raw: string, tag: string): boolean => {
	const parsed: unknown = readJson(raw)
	if (!Array.isArray(parsed)) {
		return false
	}
	return parsed.some((entry: unknown) => typeof entry === 'object' && entry !== null && Reflect.get(entry, 'ref') === `refs/tags/${tag}`)
}

/** Another program's stdout: unreadable output is "no answer", never a crash. */
const readJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw)
	} catch {
		return undefined
	}
}

/**
 * The one run `gh run list` reported, read without trusting its shape.
 *
 * `--json` output is another program's, so every field is checked rather than assumed; an answer this
 * build cannot read is "no run yet", which the bounded wait turns into a message naming the repository.
 */
const firstRun = (raw: string): UpgradeRun | undefined => {
	const parsed: unknown = readJson(raw)
	if (!Array.isArray(parsed)) {
		return undefined
	}
	const first: unknown = parsed[0]
	if (typeof first !== 'object' || first === null) {
		return undefined
	}
	const id: unknown = Reflect.get(first, 'databaseId')
	const url: unknown = Reflect.get(first, 'url')
	const status: unknown = Reflect.get(first, 'status')
	if ((typeof id !== 'number' && typeof id !== 'string') || typeof url !== 'string' || url === '') {
		return undefined
	}
	return { id: String(id), url, status: typeof status === 'string' && status !== '' ? status : 'unknown' }
}

/** A short reason for a failed shell-out. `run`/`capture` throw the command + exit code and no value. */
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The real `git` + `gh`, through the one shell-out module that keeps argv verbatim and errors short. */
export const consoleUpgradeCollaborators = (): UpgradeCollaborators => ({
	log: consoleDeployLog(),
	sleep: defaultSleep,
	signal: new AbortController().signal,
	effects: {
		hasGh: () => hasGhCli(),
		verifyTag: async (tag) => {
			try {
				const raw = await capture({
					command: 'gh',
					args: ['api', `repos/${FABRIKA_REPOSITORY}/git/matching-refs/tags/${tag}`],
					cwd: process.cwd(),
				})
				return carriesTag(raw, tag) ? { state: 'published' } : { state: 'missing' }
			} catch (error) {
				return { state: 'unavailable', reason: reasonOf(error) }
			}
		},
		cloneSidecar: async (repo) => {
			const dir = await mkdtemp(join(tmpdir(), 'fabrika-sidecar-'))
			await runStep({ command: 'gh', args: ['repo', 'clone', repo, dir], cwd: process.cwd() })
			return dir
		},
		describeCheckout: async (dir) => {
			const named = (await capture({ command: 'gh', args: ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd: dir })).trim()
			if (named === '') {
				throw new Error(`${dir} names no GitHub repository — \`gh repo view\` found no remote to push to`)
			}
			return named
		},
		// `--untracked-files=no`: the commit stages `fabrika.ref` alone, so an untracked scratch file in the
		// sidecar is nothing this command would carry into the roll.
		isDirty: async (dir) => (await capture({ command: 'git', args: ['status', '--porcelain', '--untracked-files=no'], cwd: dir })).trim() !== '',
		readBranch: async (dir) => {
			const name = (await capture({ command: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: dir })).trim()
			try {
				const ahead = (await capture({ command: 'git', args: ['rev-list', '--count', '@{u}..HEAD'], cwd: dir })).trim()
				return { name, ahead: Number.parseInt(ahead, 10) }
			} catch {
				// `@{u}` on a branch that tracks nothing is an error, not a count — and it is a real state:
				// a clone made with `git init` and never pushed has no upstream.
				return { name, ahead: undefined }
			}
		},
		commit: async ({ dir, files, message }) => {
			await runStep({ command: 'git', args: ['add', ...files], cwd: dir })
			await runStep({ command: 'git', args: ['commit', '-m', message], cwd: dir })
			return (await capture({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: dir })).trim()
		},
		push: (dir) => runStep({ command: 'git', args: ['push'], cwd: dir }),
		// `--workflow`: a sidecar may carry other workflows an operator added, and a run of one of those on
		// the same commit is not the roll this command started.
		findRun: async ({ repo, sha }) =>
			firstRun(
				await capture({
					command: 'gh',
					args: [
						'run',
						'list',
						'--repo',
						repo,
						'--workflow',
						SIDECAR_WORKFLOW_FILE,
						'--branch',
						SIDECAR_BRANCH,
						'--commit',
						sha,
						'--limit',
						'1',
						'--json',
						'databaseId,status,url',
					],
					cwd: process.cwd(),
				}),
			),
		// `--exit-status` is what makes a failed run a failed command; without it `gh run watch` exits 0.
		watchRun: ({ repo, runId }) => runStep({ command: 'gh', args: ['run', 'watch', runId, '--repo', repo, '--exit-status'], cwd: process.cwd() }),
	},
})
