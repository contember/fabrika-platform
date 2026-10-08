import { describe, expect, test } from 'bun:test'
import { assertRunnerInstance, type RunnerInstanceIds, runnerInstanceName } from '../runner-key'

// Any Worker on the account can bind `RunnerContainer` and address an instance by name. A name keyed with
// FABRIKA_RUNNER_KEY is what keeps it away from a real run's container (backlog 89).

const RUN_ID = '0198c0de-0000-7000-8000-000000000001'
const OTHER_RUN_ID = '0198c0de-0000-7000-8000-000000000002'

const id = (name: string): DurableObjectId => ({ name, toString: () => name, equals: (other) => other.name === name })
const namespace: RunnerInstanceIds = { idFromName: (name) => id(name) }

describe('runnerInstanceName', () => {
	test('is never the run id, differs per key and per run, and is stable for the same pair', async () => {
		const name = await runnerInstanceName('key-a', RUN_ID)
		expect(name).toMatch(/^[0-9a-f]{64}$/)
		expect(name).not.toContain(RUN_ID)
		expect(name).not.toContain('key-a')
		expect(await runnerInstanceName('key-a', RUN_ID)).toBe(name)
		expect(await runnerInstanceName('key-b', RUN_ID)).not.toBe(name)
		expect(await runnerInstanceName('key-a', OTHER_RUN_ID)).not.toBe(name)
	})

	test('an unset key addresses nothing', async () => {
		await expect(runnerInstanceName(undefined, RUN_ID)).rejects.toThrow('FABRIKA_RUNNER_KEY is not configured')
		await expect(runnerInstanceName('', RUN_ID)).rejects.toThrow('FABRIKA_RUNNER_KEY is not configured')
	})
})

describe('assertRunnerInstance', () => {
	test("the run's own keyed instance may act for it", async () => {
		const self = id(await runnerInstanceName('key-a', RUN_ID))
		await expect(assertRunnerInstance(namespace, self, 'key-a', RUN_ID)).resolves.toBeUndefined()
	})

	test('an instance named by the run id, by guess, under another key or for another run cannot', async () => {
		const foreign = [
			id(RUN_ID),
			id('attacker-chosen'),
			id(await runnerInstanceName('key-b', RUN_ID)),
			id(await runnerInstanceName('key-a', OTHER_RUN_ID)),
		]
		for (const self of foreign) {
			await expect(assertRunnerInstance(namespace, self, 'key-a', RUN_ID)).rejects.toThrow('runner: this instance does not belong to that run')
		}
	})

	test('an unset key refuses every instance', async () => {
		await expect(assertRunnerInstance(namespace, id(RUN_ID), undefined, RUN_ID)).rejects.toThrow('FABRIKA_RUNNER_KEY is not configured')
	})
})
