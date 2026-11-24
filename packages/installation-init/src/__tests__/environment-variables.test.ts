import { describe, expect, spyOn, test } from 'bun:test'
import { configureRepositorySecrets, environmentVariables, repositoryVariables } from '../environment'
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

describe("a repository's own Actions variables", () => {
	test('reads every page of the repository-level variables', async () => {
		const fake = gh({ exitCode: 0, stdout: '{"name":"FABRIKA_CLOUDFLARE_NAMES","value":"fabrika"}\n', stderr: '' })
		expect(await repositoryVariables('acme/platform', fake.attempt)).toEqual({ FABRIKA_CLOUDFLARE_NAMES: 'fabrika' })
		expect(fake.asked[0]?.args).toEqual(['api', '--paginate', 'repos/acme/platform/actions/variables', '--jq', '.variables[] | {name, value}'])
	})

	test('a repository that does not exist is null, and any other failure throws', async () => {
		expect(await repositoryVariables('acme/platform', gh({ exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }).attempt)).toBeNull()
		const denied = gh({ exitCode: 1, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' })
		await expect(repositoryVariables('acme/platform', denied.attempt)).rejects.toThrow('`gh api repos/acme/platform/actions/variables` failed')
	})
})

describe('repository-level secrets and variables', () => {
	test('go to the repository without --env, secrets over stdin, and no Environment is created', async () => {
		const steps: ShellStep[] = []
		const lines: string[] = []
		const stdout = spyOn(console, 'log').mockImplementation((...values) => {
			lines.push(values.map((value) => String(value)).join(' '))
		})
		try {
			await configureRepositorySecrets(
				{ repo: 'acme/platform', vars: { FABRIKA_CLOUDFLARE_NAMES: 'fabrika' }, secrets: { CLOUDFLARE_API_TOKEN: 'a-secret-value', EMPTY: '' } },
				{
					run: (step) => {
						steps.push(step)
						return Promise.resolve()
					},
				},
			)
		} finally {
			stdout.mockRestore()
		}

		expect(steps.map((step) => step.args)).toEqual([
			['variable', 'set', 'FABRIKA_CLOUDFLARE_NAMES', '--repo', 'acme/platform', '--body', 'fabrika'],
			['secret', 'set', 'CLOUDFLARE_API_TOKEN', '--repo', 'acme/platform'],
		])
		expect(steps[1]?.stdin).toBe('a-secret-value')
		expect(steps.flatMap((step) => step.args).join(' ')).not.toContain('a-secret-value')
		const output = lines.join('\n')
		expect(output).not.toContain('a-secret-value')
		expect(output).toContain('Skipping secret EMPTY')
		expect(output).toContain('No GitHub Environment: no deployment protection rule guards these secrets')
	})
})
