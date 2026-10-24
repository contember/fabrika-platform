import { describe, expect, test } from 'bun:test'
import { runSteps, type RunStepsOptions } from '..'

const steps = (...ids: string[]) => ids.map((id) => ({ id, description: `Run ${id}` }))

const options = (overrides: Partial<RunStepsOptions> & { logs?: string[] } = {}): RunStepsOptions => ({
	appId: 'api',
	env: 'production',
	dryRun: overrides.dryRun ?? false,
	signal: overrides.signal ?? new AbortController().signal,
	log: (line) => {
		overrides.logs?.push(line)
	},
})

describe('runSteps', () => {
	test('runs every step in order and logs the plan, then each step and its outcome', async () => {
		const executed: string[] = []
		const logs: string[] = []

		const result = await runSteps(steps('build', 'release'), options({ dryRun: true, logs }), async (step) => {
			executed.push(step.id)
		})

		expect(executed).toEqual(['build', 'release'])
		expect(result.status).toBe('succeeded')
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded'])
		expect(logs.slice(0, 4)).toEqual([
			'Deploy api → production (dry-run) — 2 step(s):',
			'  • build — Run build',
			'  • release — Run release',
			'→ build',
		])
		expect(logs[4]).toMatch(/^✓ build \(\d+\.\ds\)$/)
		expect(logs[5]).toBe('→ release')
		expect(logs[6]).toMatch(/^✓ release \(\d+\.\ds\)$/)
		expect(logs).toHaveLength(7)
	})

	test('stops after the first failure and marks later steps skipped', async () => {
		const executed: string[] = []
		const logs: string[] = []

		const result = await runSteps(steps('build', 'release', 'verify'), options({ logs }), async (step) => {
			executed.push(step.id)
			if (step.id === 'release') {
				throw new Error('release rejected')
			}
		})

		expect(executed).toEqual(['build', 'release'])
		expect(result.status).toBe('failed')
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'failed', 'skipped'])
		expect(result.steps[1]?.error).toBe('release rejected')
		expect(logs[0]).toBe('Deploy api → production — 3 step(s):')
		expect(logs.slice(4)).toEqual(['→ build', expect.stringMatching(/^✓ build /), '→ release', '✗ release: release rejected'])
	})

	test('skips every step of a run cancelled before it started', async () => {
		const executed: string[] = []
		const logs: string[] = []

		const result = await runSteps(steps('build', 'release'), options({ signal: AbortSignal.abort(), logs }), async (step) => {
			executed.push(step.id)
		})

		expect(executed).toEqual([])
		expect(result.status).toBe('failed')
		expect(result.steps.map((step) => step.status)).toEqual(['skipped', 'skipped'])
		expect(logs.slice(3)).toEqual(['∅ build: deploy cancelled'])
	})

	test('observes a step that rejects after the run was cancelled as it started', async () => {
		const controller = new AbortController()
		const result = await runSteps(
			steps('build'),
			{
				...options({ signal: controller.signal }),
				log: (line) => {
					if (line === '→ build') controller.abort()
				},
			},
			async () => {
				throw new Error('build noticed the cancellation')
			},
		)

		expect(result.steps).toMatchObject([{ id: 'build', status: 'failed', error: 'deploy cancelled' }])
	})

	test('abandons an in-flight step on cancellation without starting the next one', async () => {
		const controller = new AbortController()
		const started = Promise.withResolvers<void>()
		const stepFinished = Promise.withResolvers<void>()
		const executed: string[] = []
		const logs: string[] = []
		const deadline = Promise.withResolvers<never>()
		const timer = setTimeout(() => deadline.reject(new Error('runSteps did not abandon the step')), 1_000)
		const running = runSteps(steps('release', 'verify'), options({ signal: controller.signal, logs }), (step) => {
			executed.push(step.id)
			started.resolve()
			return stepFinished.promise
		})
		try {
			await Promise.race([started.promise, deadline.promise])
			controller.abort()
			const result = await Promise.race([running, deadline.promise])
			expect(result.status).toBe('failed')
			expect(result.steps.map((step) => step.status)).toEqual(['failed', 'skipped'])
			expect(result.steps[0]?.error).toBe('deploy cancelled')
			expect(executed).toEqual(['release'])
			expect(logs.at(-1)).toBe('✗ release: deploy cancelled')
		} finally {
			clearTimeout(timer)
			stepFinished.resolve()
			await running
		}
	})
})
