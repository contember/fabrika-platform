import { CLOUDFLARE_SOURCE_PROTOCOL } from '@fabrika/provider-cloudflare/runner'
import { RUNNER_PORT } from '@fabrika/runner-contract'
import { z } from 'zod'

export const runnerHealthSchema = z.object({
	status: z.literal('ok'),
	port: z.literal(RUNNER_PORT),
	sourceProtocol: z.literal(CLOUDFLARE_SOURCE_PROTOCOL),
})

export const runnerStatusSchema = z.object({
	runId: z.string(),
	state: z.enum(['pending', 'cloning', 'installing', 'deploying', 'succeeded', 'failed']),
	exitCode: z.number().finite().optional(),
	error: z.string().optional(),
	artifactState: z.enum(['complete', 'incomplete', 'not_applicable']).optional(),
	iamReconcile: z.object({ app: z.string(), schemaJson: z.string() }).passthrough().optional(),
	startedAt: z.number().finite(),
	finishedAt: z.number().finite().optional(),
}).passthrough()

export const runLogLineSchema = z.object({ ts: z.number().finite(), stream: z.enum(['stdout', 'stderr', 'meta']), text: z.string() }).passthrough()

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
