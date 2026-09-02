/**
 * The mechanics of a sidecar repository: ensure `<owner>/<name>` exists on GitHub, materialize the
 * files the CLI owns, commit and push. Idempotent, and the same on every provider:
 *   - repo absent  → create a fresh local checkout, commit the scaffold, `gh repo create … --source --push`,
 *   - repo present → clone it (if not already local), refresh the CLI-owned files, commit + push on drift.
 *
 * WHAT the files are is the provider's answer, not this module's — `materialize` writes them and `files`
 * lists everything the scaffold ever stages. Scaffold commits carry `[skip ci]`, so a push here cannot
 * deploy anything before `init` has written the GitHub Environment the pipeline reads.
 *
 * A freshly created repository is protected before anything else is written to it. An EXISTING one is
 * only PROBED, never PUT to: its protection is whatever its operator chose, and a blind PUT would replace
 * stricter rules with ours. Either way the outcome is reported, so an unprotected sidecar is never silent.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ghRepoExists, hasGhCli } from './gh'
import { detail, ok, step } from './log'
import { probeSidecarBranchProtection, type ProtectionOutcome, protectSidecarBranch } from './protection'
import { probe, run, type ShellStep } from './shell'

export const INITIAL_SCAFFOLD_COMMIT_MESSAGE = 'chore: initial fabrika platform scaffold [skip ci]'
export const REFRESH_SCAFFOLD_COMMIT_MESSAGE = 'chore: refresh fabrika platform scaffold [skip ci]'

export interface SidecarScaffoldInput {
	/** The sidecar repository, e.g. `contember/fabrika-zerops-test`. */
	readonly repo: string
	/** Local directory to check the repository out into. */
	readonly dir: string
	/** Every path the scaffold stages — CLI-owned files plus any operator-owned, write-once pin. */
	readonly files: readonly string[]
	/** Write the scaffold into an existing directory. Called for a fresh creation and for a refresh alike. */
	materialize(dir: string): Promise<void>
}

/** Result of scaffolding: the local checkout dir + whether the repository was freshly created. */
export interface SidecarScaffoldResult {
	readonly dir: string
	readonly created: boolean
	/** Applied for a repository this run created, probed read-only for one that already existed. */
	readonly branchProtection?: ProtectionOutcome
}

/** The child processes and GitHub calls the scaffold drives. Replaced wholesale in tests. */
export interface SidecarScaffoldEffects {
	hasGhCli(): Promise<boolean>
	repositoryExists(repo: string): Promise<boolean>
	run(step: ShellStep): Promise<void>
	probe(step: ShellStep): Promise<number>
	protect(repo: string): Promise<ProtectionOutcome>
	probeProtection(repo: string): Promise<ProtectionOutcome>
}

const defaultScaffoldEffects: SidecarScaffoldEffects = {
	hasGhCli,
	repositoryExists: ghRepoExists,
	run,
	probe,
	protect: (repo) => protectSidecarBranch(repo),
	probeProtection: (repo) => probeSidecarBranchProtection(repo),
}

/** True when the staged tree has changes to commit (`git diff --cached --quiet` exits 1 on drift). */
async function hasStagedChanges(effects: SidecarScaffoldEffects, dir: string): Promise<boolean> {
	return (await effects.probe({ command: 'git', args: ['diff', '--cached', '--quiet'], cwd: dir })) !== 0
}

/**
 * Ensure the sidecar repository exists and carries the current scaffold. Returns the local checkout.
 * Requires `gh` authenticated with rights to create/administer the repository.
 */
export async function scaffoldSidecarRepository(
	input: SidecarScaffoldInput,
	effects: SidecarScaffoldEffects = defaultScaffoldEffects,
): Promise<SidecarScaffoldResult> {
	step(`Scaffold the sidecar repository (${input.repo})`)
	if (!(await effects.hasGhCli())) {
		throw new Error('`gh` (GitHub CLI) is required — install it and run `gh auth login`.')
	}
	return (await effects.repositoryExists(input.repo)) ? updateExisting(input, effects) : createFresh(input, effects)
}

/** Repository already exists: clone if needed, refresh CLI-owned files, commit + push on drift. */
async function updateExisting(input: SidecarScaffoldInput, effects: SidecarScaffoldEffects): Promise<SidecarScaffoldResult> {
	const { repo, dir } = input
	if (!existsSync(resolve(dir, '.git'))) {
		detail(`Cloning ${repo} → ${dir}`)
		await effects.run({ command: 'gh', args: ['repo', 'clone', repo, dir], cwd: process.cwd() })
	} else {
		detail(`Reusing existing checkout at ${dir}`)
	}
	await input.materialize(dir)
	await effects.run({ command: 'git', args: ['add', ...input.files], cwd: dir })
	if (!(await hasStagedChanges(effects, dir))) {
		ok('Sidecar repository already up to date (no scaffold drift).')
		return { dir, created: false, branchProtection: await effects.probeProtection(repo) }
	}
	await effects.run({ command: 'git', args: ['commit', '-m', REFRESH_SCAFFOLD_COMMIT_MESSAGE], cwd: dir })
	await effects.run({ command: 'git', args: ['push'], cwd: dir })
	ok('Sidecar repository scaffold updated + pushed.')
	return { dir, created: false, branchProtection: await effects.probeProtection(repo) }
}

/** Repository does not exist: build a local checkout, commit the scaffold, create + push in one `gh` call. */
async function createFresh(input: SidecarScaffoldInput, effects: SidecarScaffoldEffects): Promise<SidecarScaffoldResult> {
	const { repo, dir } = input
	if (existsSync(resolve(dir, '.git'))) {
		throw new Error(`${dir} is already a git repo but ${repo} does not exist on GitHub — resolve the mismatch by hand.`)
	}
	detail(`Creating a fresh checkout at ${dir}`)
	await effects.run({ command: 'git', args: ['init', '-b', 'main', dir], cwd: process.cwd() })
	await input.materialize(dir)
	await effects.run({ command: 'git', args: ['add', ...input.files], cwd: dir })
	await effects.run({ command: 'git', args: ['commit', '-m', INITIAL_SCAFFOLD_COMMIT_MESSAGE], cwd: dir })
	detail(`Creating ${repo} (private) and pushing`)
	await effects.run({
		command: 'gh',
		args: ['repo', 'create', repo, '--private', '--source', dir, '--remote', 'origin', '--push'],
		cwd: process.cwd(),
	})
	ok(`Sidecar repository ${repo} created + pushed.`)
	return { dir, created: true, branchProtection: await effects.protect(repo) }
}
