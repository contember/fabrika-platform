import { runLogLineSchema } from '@fabrika/control-contract'
import { type RunnerStatus, runnerStatusSchema } from '@fabrika/runner-contract'
import { z } from 'zod'

export const backstopPayloadSchema = z.object({ runId: z.string(), deadline: z.number().finite() })

export const parseRunnerStatus = (value: unknown, runId: string) => {
	const parsed = runnerStatusSchema.safeParse(value)
	if (!parsed.success || parsed.data.runId !== runId) throw new Error('runner returned malformed status')
	return parsed.data
}

export const parseRunLogLine = (raw: string) => {
	try {
		const parsed = runLogLineSchema.safeParse(JSON.parse(raw))
		if (parsed.success) return parsed.data
	} catch {}
	throw new Error('runner returned malformed log line')
}

/** Mark a status dry from the runner's own record of the job; whatever the container claimed is dropped. */
export const stampDryRun = (status: RunnerStatus, dryRun: boolean): RunnerStatus => {
	const { dryRun: _reported, ...rest } = status
	return dryRun ? { ...rest, dryRun: true } : rest
}
