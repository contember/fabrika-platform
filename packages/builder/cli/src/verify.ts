import type { BuildEvidence } from './build-status'

/** What an issue's check runs: its acceptance files under `bun test`, or the command the driver names. */
export type Verification = { kind: 'files'; files: string[] } | { kind: 'command'; command: string }

export function verificationCommand(verification: Verification): string[] {
	// `bun test` reads a bare argument as a name filter; a `./` path names exactly that file.
	return verification.kind === 'files'
		? [process.execPath, 'test', ...verification.files.map((file) => `./${file}`)]
		: ['sh', '-c', verification.command]
}

export function describeVerification(verification: Verification): string {
	return verification.kind === 'files' ? `bun test ${verification.files.join(' ')}` : verification.command
}

/** Runs the check in the repository with the driver's terminal attached, and returns what happened. */
export async function runVerification(repoRoot: string, verification: Verification, now: () => Date = () => new Date()): Promise<BuildEvidence> {
	const started = performance.now()
	const exitCode = await runCommand(repoRoot, verificationCommand(verification))
	const durationMs = Math.round(performance.now() - started)
	return { command: describeVerification(verification), exitCode, durationMs, at: now().toISOString(), ...gitState(repoRoot) }
}

async function runCommand(repoRoot: string, command: string[]): Promise<number> {
	try {
		return await Bun.spawn(command, { cwd: repoRoot, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exited
	} catch {
		console.error(`[fabrika] could not start \`${command[0]}\``)
		return 127
	}
}

/** `commit` is null before the first commit and outside git; `dirty` is true whenever git cannot tell. */
export function gitState(repoRoot: string): { commit: string | null; dirty: boolean } {
	if (git(repoRoot, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return { commit: null, dirty: false }
	const head = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim()
	// Only the application's own tree counts; the builder's state under .fabrika/ changes with every record.
	const status = git(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':!.fabrika'])
	return { commit: head ? head : null, dirty: status === null || status.trim().length > 0 }
}

function git(cwd: string, args: string[]): string | null {
	try {
		const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' })
		return proc.exitCode === 0 ? proc.stdout.toString() : null
	} catch {
		return null
	}
}
