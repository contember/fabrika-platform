import type { BuildEvidence } from './build-status'

/** What an issue's check runs: its acceptance files under `bun test`, or the command the driver names. */
export type Verification = { kind: 'files'; files: string[] } | { kind: 'command'; command: string }

export function verificationCommand(verification: Verification): string[] {
	return verification.kind === 'files' ? ['bun', 'test', ...verification.files] : ['sh', '-c', verification.command]
}

export function describeVerification(verification: Verification): string {
	return verification.kind === 'files' ? `bun test ${verification.files.join(' ')}` : verification.command
}

/** Runs the check in the repository with the driver's terminal attached, and returns what happened. */
export async function runVerification(repoRoot: string, verification: Verification, now: () => Date = () => new Date()): Promise<BuildEvidence> {
	const started = performance.now()
	const proc = Bun.spawn(verificationCommand(verification), { cwd: repoRoot, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
	const exitCode = await proc.exited
	const durationMs = Math.round(performance.now() - started)
	return { command: describeVerification(verification), exitCode, durationMs, at: now().toISOString(), ...gitState(repoRoot) }
}

function gitState(repoRoot: string): { commit: string | null; dirty: boolean } {
	const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot, stdout: 'pipe', stderr: 'ignore' })
	if (head.exitCode !== 0) return { commit: null, dirty: false }
	// The builder's own state under .fabrika/ changes with every record, so it never counts as an uncommitted change.
	const status = Bun.spawnSync(['git', 'status', '--porcelain', '--', '.', ':!.fabrika'], { cwd: repoRoot, stdout: 'pipe', stderr: 'ignore' })
	return { commit: head.stdout.toString().trim(), dirty: status.exitCode !== 0 || status.stdout.toString().trim().length > 0 }
}
