// What `advance` approved: per phase, the content of every input it read at that moment. Shared by the CLI and the daemon.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { PHASE_IDS, type PhaseId } from './phases'

export const APPROVALS_FILE = 'approvals.json'

const approvalSchema = z.object({
	at: z.string(),
	/** Repository-relative path → sha256 of its content, for every file the phase's `reads` matched. */
	inputs: z.record(z.string(), z.string()),
	/** `advance --force`: the gate was waived, not reviewed. */
	waived: z.boolean().optional(),
})
export type PhaseApproval = z.infer<typeof approvalSchema>

const approvalsSchema = z.object({
	version: z.literal(1),
	phases: z.record(z.string(), z.unknown()),
}).transform(({ phases }) => {
	const out: Partial<Record<PhaseId, PhaseApproval>> = {}
	for (const id of PHASE_IDS) {
		// A record that does not parse reads as missing: its phase is approved again rather than trusted.
		const parsed = approvalSchema.safeParse(phases[id])
		if (parsed.success) out[id] = parsed.data
	}
	return out
})
export type Approvals = Partial<Record<PhaseId, PhaseApproval>>

/** Null for a project initialized before approvals existed: its gates are judged by their reviews alone until `advance` writes the file. */
export function readApprovals(repoRoot: string): Approvals | null {
	const path = approvalsPath(repoRoot)
	if (!existsSync(path)) return null
	try {
		const parsed = approvalsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
		return parsed.success ? parsed.data : {}
	} catch {
		return {}
	}
}

export function writeApprovals(repoRoot: string, approvals: Approvals): void {
	const path = approvalsPath(repoRoot)
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, JSON.stringify({ version: 1, phases: approvals }, null, 2) + '\n')
	renameSync(tmp, path)
}

function approvalsPath(repoRoot: string): string {
	return join(repoRoot, '.fabrika', APPROVALS_FILE)
}
