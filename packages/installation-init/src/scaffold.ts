/**
 * The mechanics of a sidecar repository: ensure `<owner>/<name>` exists on GitHub, materialize the
 * files the CLI owns, commit and push. Idempotent, and the same on every provider:
 *   - repo absent  → create a fresh local checkout, commit the scaffold, `gh repo create … --source --push`,
 *   - repo present → clone it (if not already local), refresh the CLI-owned files, commit + push on drift.
 *
 * WHAT the files are is the provider's answer, not this module's — `materialize` writes them and `files`
 * lists everything the scaffold ever stages. Scaffold commits carry `[skip ci]`, so a push here cannot
 * deploy anything before `init` has written the GitHub Environment the pipeline reads.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ghRepoExists, hasGhCli } from './gh'
import { detail, ok, step } from './log'
import { probe, run } from './shell'

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
}

/** True when the staged tree has changes to commit (`git diff --cached --quiet` exits 1 on drift). */
async function hasStagedChanges(dir: string): Promise<boolean> {
	return (await probe({ command: 'git', args: ['diff', '--cached', '--quiet'], cwd: dir })) !== 0
}

/**
 * Ensure the sidecar repository exists and carries the current scaffold. Returns the local checkout.
 * Requires `gh` authenticated with rights to create/administer the repository.
 */
export async function scaffoldSidecarRepository(input: SidecarScaffoldInput): Promise<SidecarScaffoldResult> {
	step(`Scaffold the sidecar repository (${input.repo})`)
	if (!(await hasGhCli())) {
		throw new Error('`gh` (GitHub CLI) is required — install it and run `gh auth login`.')
	}
	return (await ghRepoExists(input.repo)) ? updateExisting(input) : createFresh(input)
}

/** Repository already exists: clone if needed, refresh CLI-owned files, commit + push on drift. */
async function updateExisting(input: SidecarScaffoldInput): Promise<SidecarScaffoldResult> {
	const { repo, dir } = input
	if (!existsSync(resolve(dir, '.git'))) {
		detail(`Cloning ${repo} → ${dir}`)
		await run({ command: 'gh', args: ['repo', 'clone', repo, dir], cwd: process.cwd() })
	} else {
		detail(`Reusing existing checkout at ${dir}`)
	}
	await input.materialize(dir)
	await run({ command: 'git', args: ['add', ...input.files], cwd: dir })
	if (!(await hasStagedChanges(dir))) {
		ok('Sidecar repository already up to date (no scaffold drift).')
		return { dir, created: false }
	}
	await run({ command: 'git', args: ['commit', '-m', REFRESH_SCAFFOLD_COMMIT_MESSAGE], cwd: dir })
	await run({ command: 'git', args: ['push'], cwd: dir })
	ok('Sidecar repository scaffold updated + pushed.')
	return { dir, created: false }
}

/** Repository does not exist: build a local checkout, commit the scaffold, create + push in one `gh` call. */
async function createFresh(input: SidecarScaffoldInput): Promise<SidecarScaffoldResult> {
	const { repo, dir } = input
	if (existsSync(resolve(dir, '.git'))) {
		throw new Error(`${dir} is already a git repo but ${repo} does not exist on GitHub — resolve the mismatch by hand.`)
	}
	detail(`Creating a fresh checkout at ${dir}`)
	await run({ command: 'git', args: ['init', '-b', 'main', dir], cwd: process.cwd() })
	await input.materialize(dir)
	await run({ command: 'git', args: ['add', ...input.files], cwd: dir })
	await run({ command: 'git', args: ['commit', '-m', INITIAL_SCAFFOLD_COMMIT_MESSAGE], cwd: dir })
	detail(`Creating ${repo} (private) and pushing`)
	await run({
		command: 'gh',
		args: ['repo', 'create', repo, '--private', '--source', dir, '--remote', 'origin', '--push'],
		cwd: process.cwd(),
	})
	ok(`Sidecar repository ${repo} created + pushed.`)
	return { dir, created: true }
}
