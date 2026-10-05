import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureEnvironment, existingEnvironmentProtection } from '../environment'
import { probeSidecarBranchProtection, protectSidecarBranch } from '../protection'
import { scaffoldSidecarRepository, type SidecarScaffoldEffects } from '../scaffold'
import type { ShellAttempt, ShellStep } from '../shell'

const OK: ShellAttempt = { exitCode: 0, stdout: '', stderr: '' }
const FORBIDDEN: ShellAttempt = {
	exitCode: 1,
	stdout: '',
	stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n',
}
const NOT_FOUND: ShellAttempt = { exitCode: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)\n' }
const SERVER_ERROR: ShellAttempt = { exitCode: 1, stdout: '', stderr: 'gh: Internal Server Error (HTTP 500)\n' }

/** Every recorded call, plus the console lines, so a test can assert what never reached argv. */
interface Recorder {
	readonly steps: ShellStep[]
	readonly output: string[]
}

async function record(run: (recorder: Recorder) => Promise<void>): Promise<Recorder> {
	const recorder: Recorder = { steps: [], output: [] }
	const stdout = spyOn(console, 'log').mockImplementation((...values) => {
		recorder.output.push(values.map((value) => String(value)).join(' '))
	})
	try {
		await run(recorder)
	} finally {
		stdout.mockRestore()
	}
	return recorder
}

const argv = (recorder: Recorder): string => recorder.steps.map((step) => `${step.command} ${step.args.join(' ')}`).join('\n')

describe('sidecar branch protection', () => {
	test('PUTs the stated rules on main with the body on stdin', async () => {
		const recorder = await record(async (rec) => {
			const outcome = await protectSidecarBranch('acme/fabrika-platform', (step) => {
				rec.steps.push(step)
				return Promise.resolve(OK)
			})
			expect(outcome.applied).toBe(true)
		})

		const [step] = recorder.steps
		expect(step?.args).toEqual(['api', '-X', 'PUT', 'repos/acme/fabrika-platform/branches/main/protection', '--input', '-'])
		expect(JSON.parse(step?.stdin ?? '{}')).toEqual({
			required_status_checks: null,
			enforce_admins: true,
			required_pull_request_reviews: null,
			restrictions: null,
			allow_force_pushes: false,
			allow_deletions: false,
		})
		expect(argv(recorder)).not.toContain('enforce_admins')
	})

	test('a 403 warns, names the command to run later, and does not throw', async () => {
		const recorder = await record(async (rec) => {
			const outcome = await protectSidecarBranch('acme/fabrika-platform', (step) => {
				rec.steps.push(step)
				return Promise.resolve(FORBIDDEN)
			})
			expect(outcome.applied).toBe(false)
			expect(outcome.reason).toContain('HTTP 403')
			expect(outcome.command).toContain('repos/acme/fabrika-platform/branches/main/protection')
		})

		const printed = recorder.output.join('\n')
		expect(printed).toContain('main is UNPROTECTED on acme/fabrika-platform')
		expect(printed).toContain('gh api -X PUT repos/acme/fabrika-platform/branches/main/protection --input -')
	})

	test('a fresh repository is PUT to; an existing one is only probed', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'fabrika-scaffold-'))
		try {
			const calls: string[] = []
			const effects: SidecarScaffoldEffects = {
				hasGhCli: () => Promise.resolve(true),
				repositoryExists: () => Promise.resolve(false),
				run: () => Promise.resolve(),
				probe: () => Promise.resolve(0),
				protect: (repo) => {
					calls.push(`protect ${repo}`)
					return Promise.resolve({ applied: true, command: 'gh api …' })
				},
				probeProtection: (repo) => {
					calls.push(`probeProtection ${repo}`)
					return Promise.resolve({ applied: false, reason: 'HTTP 404 — no protection rule on main', command: 'gh api …' })
				},
			}
			const input = { repo: 'acme/fabrika-platform', dir: join(directory, 'checkout'), files: ['README.md'], materialize: () => Promise.resolve() }

			await record(async () => {
				const fresh = await scaffoldSidecarRepository(input, effects)
				expect(fresh.created).toBe(true)
				expect(fresh.branchProtection?.applied).toBe(true)

				const existing = await scaffoldSidecarRepository(input, { ...effects, repositoryExists: () => Promise.resolve(true) })
				expect(existing.created).toBe(false)
				expect(existing.branchProtection?.applied).toBe(false)
			})
			expect(calls).toEqual(['protect acme/fabrika-platform', 'probeProtection acme/fabrika-platform'])
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('the existing-repo probe reads, never writes, and a 404 names the command', async () => {
		const recorder = await record(async (rec) => {
			const outcome = await probeSidecarBranchProtection('acme/fabrika-platform', (step) => {
				rec.steps.push(step)
				return Promise.resolve(NOT_FOUND)
			})
			expect(outcome.applied).toBe(false)
			expect(outcome.reason).toBe('HTTP 404 — no protection rule on main')
			expect(outcome.command).toContain('branches/main/protection')
		})

		expect(recorder.steps[0]?.args).toEqual(['api', 'repos/acme/fabrika-platform/branches/main/protection'])
		expect(recorder.steps[0]?.stdin).toBeUndefined()
		expect(argv(recorder)).not.toContain('PUT')
		const printed = recorder.output.join('\n')
		expect(printed).toContain('main is UNPROTECTED on acme/fabrika-platform')
		expect(printed).toContain('gh api -X PUT repos/acme/fabrika-platform/branches/main/protection --input -')
	})
})

describe('GitHub Environment protection', () => {
	const config = { repo: 'acme/fabrika-platform', environment: 'acme', secrets: { A_KEY: 'a-secret-value' }, vars: { A_VAR: 'a-var-value' } }

	test('creates the environment with the deployment-branch policy over stdin', async () => {
		let outcome: { applied: boolean } | undefined
		const recorder = await record(async (rec) => {
			await configureEnvironment({ ...config, onProtection: (value) => void (outcome = value) }, {
				attempt: (step) => {
					rec.steps.push(step)
					return Promise.resolve(step.args.includes('-X') ? OK : NOT_FOUND)
				},
				run: (step) => {
					rec.steps.push(step)
					return Promise.resolve()
				},
			})
		})

		expect(outcome?.applied).toBe(true)
		expect(recorder.steps[0]?.args).toEqual(['api', 'repos/acme/fabrika-platform/environments/acme'])
		const create = recorder.steps[1]
		expect(create?.args).toEqual(['api', '-X', 'PUT', 'repos/acme/fabrika-platform/environments/acme', '--input', '-'])
		expect(JSON.parse(create?.stdin ?? '{}')).toEqual({
			deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
		})
		expect(argv(recorder)).not.toContain('deployment_branch_policy')
		expect(argv(recorder)).not.toContain('a-secret-value')
		expect(recorder.output.join('\n')).toContain('gh api user --jq .id')
	})

	test('creates the environment even when no caller wants the outcome', async () => {
		const recorder = await record(async (rec) => {
			await configureEnvironment(config, {
				attempt: (step) => {
					rec.steps.push(step)
					return Promise.resolve(step.args.includes('-X') ? OK : NOT_FOUND)
				},
				run: (step) => {
					rec.steps.push(step)
					return Promise.resolve()
				},
			})
		})

		expect(recorder.steps.some((step) => step.args.includes('-X') && step.args.includes('PUT'))).toBe(true)
	})

	test('a 403 falls back to a plain create, warns, and still writes the secrets', async () => {
		let outcome: { applied: boolean; reason?: string } | undefined
		const recorder = await record(async (rec) => {
			await configureEnvironment({ ...config, onProtection: (value) => void (outcome = value) }, {
				attempt: (step) => {
					rec.steps.push(step)
					if (!step.args.includes('-X')) return Promise.resolve(NOT_FOUND)
					return Promise.resolve(step.stdin === undefined ? OK : FORBIDDEN)
				},
				run: (step) => {
					rec.steps.push(step)
					return Promise.resolve()
				},
			})
		})

		expect(outcome?.applied).toBe(false)
		expect(outcome?.reason).toContain('HTTP 403')
		expect(recorder.steps[2]?.args).toEqual(['api', '-X', 'PUT', 'repos/acme/fabrika-platform/environments/acme'])
		expect(recorder.steps.some((step) => step.args[0] === 'secret')).toBe(true)
		expect(recorder.output.join('\n')).toContain('has NO deployment-branch policy')
	})
})

describe('GitHub Environment protection merge', () => {
	const config = { repo: 'acme/fabrika-platform', environment: 'acme', secrets: {}, vars: {} }
	const EXISTING: ShellAttempt = {
		exitCode: 0,
		stdout: JSON.stringify({
			protection_rules: [
				{ id: 1, type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 42, login: 'ops' } }] },
				{ id: 2, type: 'wait_timer', wait_timer: 15 },
				{ id: 3, type: 'branch_policy' },
			],
		}),
		stderr: '',
	}

	test('carries an existing reviewer and wait timer into the PUT body', async () => {
		const recorder = await record(async (rec) => {
			await configureEnvironment(config, {
				attempt: (step) => {
					rec.steps.push(step)
					return Promise.resolve(step.args.includes('-X') ? OK : EXISTING)
				},
				run: () => Promise.resolve(),
			})
		})

		expect(recorder.steps[0]?.args).toEqual(['api', 'repos/acme/fabrika-platform/environments/acme'])
		expect(JSON.parse(recorder.steps[1]?.stdin ?? '{}')).toEqual({
			reviewers: [{ type: 'User', id: 42 }],
			wait_timer: 15,
			deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
		})
	})

	test('a GET that fails for any reason other than 404 warns that a reviewer may be reset', async () => {
		const recorder = await record(async (rec) => {
			await configureEnvironment(config, {
				attempt: (step) => {
					rec.steps.push(step)
					return Promise.resolve(step.args.includes('-X') ? OK : SERVER_ERROR)
				},
				run: () => Promise.resolve(),
			})
		})

		expect(recorder.output.join('\n')).toContain('may be reset by this write')
		expect(JSON.parse(recorder.steps[1]?.stdin ?? '{}')).toEqual({
			deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
		})
	})

	test('a fresh environment (GET 404) merges nothing and warns about nothing', async () => {
		const recorder = await record(async (rec) => {
			await configureEnvironment(config, {
				attempt: (step) => {
					rec.steps.push(step)
					return Promise.resolve(step.args.includes('-X') ? OK : NOT_FOUND)
				},
				run: () => Promise.resolve(),
			})
		})

		expect(recorder.output.join('\n')).not.toContain('may be reset by this write')
	})

	test('a 500 from the policy PUT is rethrown, never degraded to a plain create', async () => {
		const steps: ShellStep[] = []
		await expect(record(async () => {
			await configureEnvironment(config, {
				attempt: (step) => {
					steps.push(step)
					return Promise.resolve(step.args.includes('-X') ? SERVER_ERROR : NOT_FOUND)
				},
				run: () => Promise.resolve(),
			})
		})).rejects.toThrow('HTTP 500')
		expect(steps.filter((step) => step.args.includes('-X'))).toHaveLength(1)
	})

	test('reads nothing out of an unparseable or unexpected environment document', () => {
		expect(existingEnvironmentProtection({ exitCode: 0, stdout: 'not json', stderr: '' })).toEqual({})
		expect(existingEnvironmentProtection({ exitCode: 0, stdout: '{"protection_rules":[{"type":"branch_policy"}]}', stderr: '' })).toEqual({})
		expect(existingEnvironmentProtection(NOT_FOUND)).toEqual({})
	})

	test('filters each rule and reviewer independently and keeps the last usable protection', () => {
		const protection_rules = [
			null,
			{ type: 'wait_timer', wait_timer: 5 },
			{ type: 'wait_timer', wait_timer: '20' },
			{
				type: 'required_reviewers',
				reviewers: [null, { type: 'User', reviewer: { id: 7, login: 'operator' } }, { type: 'User', reviewer: { id: '8' } }],
			},
			{ type: 'required_reviewers', reviewers: [false] },
			{ type: 'wait_timer', wait_timer: -0.5 },
		]
		expect(existingEnvironmentProtection({ exitCode: 0, stdout: JSON.stringify({ protection_rules }), stderr: '' })).toEqual({
			reviewers: [{ type: 'User', id: 7 }],
			wait_timer: -0.5,
		})
	})
})
