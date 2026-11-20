import { describe, expect, test } from 'bun:test'
import { environmentVariables } from '../environment'
import type { ShellAttempt, ShellStep } from '../shell'

/** A `gh` that answers one call with `answer` and records what it was asked. */
const gh = (answer: ShellAttempt) => {
	const asked: ShellStep[] = []
	return {
		asked,
		attempt: (step: ShellStep): Promise<ShellAttempt> => {
			asked.push(step)
			return Promise.resolve(answer)
		},
	}
}

describe("a GitHub Environment's variables", () => {
	test('reads every page as name and value', async () => {
		const fake = gh({ exitCode: 0, stdout: '{"name":"FABRIKA_CONTROL_DOMAIN","value":"fabrika.example.com"}\n{"name":"X","value":""}\n', stderr: '' })
		expect(await environmentVariables('acme/platform', 'acme', fake.attempt)).toEqual({ FABRIKA_CONTROL_DOMAIN: 'fabrika.example.com', X: '' })
		expect(fake.asked[0]?.args).toEqual([
			'api',
			'--paginate',
			'repos/acme/platform/environments/acme/variables',
			'--jq',
			'.variables[] | {name, value}',
		])
	})

	test('an Environment with no variables is empty, and one that does not exist is null', async () => {
		expect(await environmentVariables('acme/platform', 'acme', gh({ exitCode: 0, stdout: '', stderr: '' }).attempt)).toEqual({})
		const missing = gh({ exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' })
		expect(await environmentVariables('acme/platform', 'acme', missing.attempt)).toBeNull()
	})

	test('any other failure throws: whether an installation exists is never guessed', async () => {
		const denied = gh({ exitCode: 1, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' })
		await expect(environmentVariables('acme/platform', 'acme', denied.attempt)).rejects.toThrow(
			'`gh api repos/acme/platform/environments/acme/variables` failed',
		)
	})
})
