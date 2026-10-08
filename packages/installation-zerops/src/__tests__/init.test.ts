import type { EnvironmentConfig, SidecarScaffoldInput, SidecarScaffoldResult } from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { checkedEnvironmentName, type InitCollaborators, inspectPlatform, parseInitArgs, runInit, sourceConnectionSettingsUrl } from '../init'
import { recordingInitLog } from '../log'
import { MACHINE_KEY_NEXT_STEP_TITLE } from '../machine-key'
import { fakeZerops, platformServices } from './fake-zerops'

const ACCESS_TOKEN = 'zerops-access-token-value-that-must-never-be-printed'
const PROVISIONING_KEY = 'px_provisioning-key-value-that-must-never-be-printed'
/** What the LIVE control service holds, so the closing block is asserted against a real-looking env. */
const LIVE_RPC_KEY = 'rpc_live-value-that-must-never-be-printed'
const LIVE_PROVISIONING_KEY = 'px_live-value-that-must-never-be-printed'

interface Recorder {
	readonly collaborators: InitCollaborators
	readonly asked: string[]
	readonly effects: string[]
	readonly lines: readonly string[]
	readonly environments: EnvironmentConfig[]
	readonly scaffolds: SidecarScaffoldInput[]
	readonly inspectInputs: Parameters<InitCollaborators['effects']['inspectPlatform']>[0][]
}

const recorder = (options: {
	readonly answers: Record<string, string>
	readonly confirms?: Record<string, boolean>
	readonly repositoryExists?: boolean
	readonly custom?: boolean
	readonly controlEnvironment?: Readonly<Record<string, string>>
	readonly proxyPublished?: boolean
}): Recorder => {
	const asked: string[] = []
	const effects: string[] = []
	const environments: EnvironmentConfig[] = []
	const scaffolds: SidecarScaffoldInput[] = []
	const inspectInputs: Parameters<InitCollaborators['effects']['inspectPlatform']>[0][] = []
	const derivedControlHost = 'proxy-292c-8082.prg1.zerops.app'
	const derivedIamHost = 'proxy-292c-8080.prg1.zerops.app'
	const controlEnv = new Map([
		['FABRIKA_CONTROL_DOMAIN', options.custom === true ? options.answers['Console hostname'] ?? '' : derivedControlHost],
		['FABRIKA_IAM_ISSUER', `https://${options.custom === true ? options.answers['IAM hostname'] ?? '' : derivedIamHost}`],
		// The live control service holds every platform credential; init reads its whole environment.
		['FABRIKA_IAM_RPC_KEY', LIVE_RPC_KEY],
		['FABRIKA_IAM_PROVISIONING_KEY', LIVE_PROVISIONING_KEY],
		...Object.entries(options.controlEnvironment ?? {}),
	])
	const proxyEnv = new Map([[
		'zeropsSubdomain',
		[
			'https://proxy-292c-8080.prg1.zerops.app',
			'https://proxy-292c-8082.prg1.zerops.app',
			'https://proxy-292c-8083.prg1.zerops.app',
		].join('\n'),
	]])
	const log = recordingInitLog()
	return {
		asked,
		effects,
		environments,
		scaffolds,
		inspectInputs,
		lines: log.lines,
		collaborators: {
			log,
			prompts: {
				text: async (question, fallback) => {
					asked.push(`text: ${question}`)
					return options.answers[question] ?? fallback ?? ''
				},
				confirm: async (question, defaultYes) => {
					asked.push(`confirm: ${question}`)
					return options.confirms?.[question] ?? defaultYes ?? false
				},
				select: async (question, choices) => {
					asked.push(`select: ${question}`)
					const selected = choices[options.custom === true ? 1 : 0]
					if (selected === undefined) throw new Error('no option')
					return selected.value
				},
				secret: async (variable) => {
					asked.push(`secret: ${variable}`)
					if (variable === 'FABRIKA_ZEROPS_ACCESS_TOKEN') return ACCESS_TOKEN
					if (variable === 'FABRIKA_IAM_PROVISIONING_KEY') return PROVISIONING_KEY
					return ''
				},
			},
			effects: {
				repositoryExists: async (repo) => {
					effects.push(`exists: ${repo}`)
					return options.repositoryExists ?? false
				},
				scaffold: async (input): Promise<SidecarScaffoldResult> => {
					effects.push(`scaffold: ${input.repo}`)
					scaffolds.push(input)
					await input.materialize(input.dir)
					return { dir: input.dir, created: true }
				},
				configureEnvironment: async (config) => {
					effects.push(`environment: ${config.environment}`)
					environments.push(config)
				},
				triggerWorkflow: async (repo) => void effects.push(`trigger: ${repo}`),
				describeProject: async ({ projectId }) => {
					effects.push(`describe: ${projectId}`)
					return 'fabrika-test'
				},
				inspectPlatform: async (input) => {
					inspectInputs.push(input)
					effects.push(`inspect: ${input.projectId}`)
					return { controlEnv, proxyEnv, proxyPublished: options.proxyPublished ?? true }
				},
			},
		},
	}
}

const ANSWERS = {
	'fabrika-platform tag to pin (a published tag, never a branch)': 'v0.1.0',
	'Zerops project id (the project holding iam, operations, proxy and control)': 'project-id-1',
}

const cleanCheckout = async (recorded: Recorder): Promise<void> => {
	for (const scaffold of recorded.scaffolds) await rm(scaffold.dir, { recursive: true, force: true })
}

describe('fabrika platform init --provider=zerops', () => {
	test('writes nothing to Zerops and confirms only its five outward steps', async () => {
		const recorded = recorder({ answers: ANSWERS })
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.effects).toEqual([
			'describe: project-id-1',
			'inspect: project-id-1',
			'exists: contember/fabrika-zerops-test',
			'scaffold: contember/fabrika-zerops-test',
			'environment: test',
			'trigger: contember/fabrika-zerops-test',
		])
		expect(recorded.asked.filter((entry) => entry.startsWith('confirm: '))).toHaveLength(5)
		const transcript = recorded.lines.join('\n')
		expect(transcript).toContain('Public repositories deploy without a GitHub App')
		expect(transcript).toContain('https://proxy-292c-8082.prg1.zerops.app/settings/source')
		for (const forbidden of ['GitHub App name', 'GitHub organization', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET']) {
			expect(recorded.asked.join('\n')).not.toContain(forbidden)
		}
		await cleanCheckout(recorded)
	})

	test('writes exactly the two deployment credentials and nonsecret deploy configuration', async () => {
		const recorded = recorder({ answers: ANSWERS })
		await runInit({ installation: 'test' }, recorded.collaborators)
		const written = recorded.environments[0]
		expect(Object.keys(written?.secrets ?? {})).toEqual(['FABRIKA_ZEROPS_ACCESS_TOKEN', 'FABRIKA_IAM_PROVISIONING_KEY'])
		expect(written?.vars).toEqual({
			FABRIKA_ZEROPS_PROJECT_ID: 'project-id-1',
			FABRIKA_PLATFORM_ENVIRONMENT: 'test',
			FABRIKA_PLATFORM_SCHEME: 'https',
		})
		const transcript = recorded.lines.join('\n')
		expect(transcript).not.toContain(ACCESS_TOKEN)
		expect(transcript).not.toContain(PROVISIONING_KEY)
		expect(recorded.asked.join('\n')).not.toContain('Public repository Zerops builds each service from')
		const scaffold = recorded.scaffolds[0]
		if (scaffold === undefined || written === undefined) throw new Error('init did not configure its sidecar')
		const workflow = await Bun.file(`${scaffold.dir}/.github/workflows/platform.yml`).text()
		for (const variable of Object.keys(written.vars ?? {})) {
			expect(workflow).toContain(`vars.${variable}`)
		}
		expect(workflow).toContain('--source-dir=.')
		expect(workflow).not.toContain('FABRIKA_ZEROPS_BUILD_FROM_GIT')
		await cleanCheckout(recorded)
	})

	test('prints only a strictly verified custom Control settings URL', async () => {
		const answers = {
			...ANSWERS,
			'IAM hostname': 'iam.example.com',
			'Console hostname': 'console.example.com',
			'Operations ingest hostname': 'errors.example.com',
		}
		const matching = recorder({ custom: true, answers })
		await runInit({ installation: 'test' }, matching.collaborators)
		expect(matching.lines.join('\n')).toContain('https://console.example.com/settings/source')
		expect(matching.environments[0]?.vars).toMatchObject({ FABRIKA_PLATFORM_CONSOLE_HOST: 'console.example.com' })
		await cleanCheckout(matching)

		const mismatch = recorder({ custom: true, answers, controlEnvironment: { FABRIKA_CONTROL_DOMAIN: 'other.example.com' } })
		await runInit({ installation: 'test' }, mismatch.collaborators)
		expect(mismatch.lines.join('\n')).toContain('No unverified URL was guessed')
		expect(mismatch.lines.join('\n')).not.toContain('https://other.example.com/settings/source')
		await cleanCheckout(mismatch)
	})

	test('rejects a Control domain that is not a bare host', () => {
		expect(sourceConnectionSettingsUrl({}, {
			controlEnv: new Map([['FABRIKA_CONTROL_DOMAIN', 'user@example.com']]),
			proxyEnv: new Map(),
			proxyPublished: true,
		})).toBeUndefined()
	})

	test('redacts inspection and project failures and honors declined steps', async () => {
		const inspectFailure = recorder({ answers: ANSWERS })
		const inspectCollaborators: InitCollaborators = {
			...inspectFailure.collaborators,
			effects: { ...inspectFailure.collaborators.effects, inspectPlatform: () => Promise.reject(new Error(`private ${LIVE_RPC_KEY}`)) },
		}
		const inspectError = await runInit({ installation: 'test' }, inspectCollaborators).catch((error: unknown) => error)
		expect(inspectError instanceof Error ? inspectError.message : '').toBe(
			'the `control` and `proxy` services could not be read; no credential value is shown. Inspect them in Zerops, then run init again',
		)

		const declined = recorder({
			answers: ANSWERS,
			confirms: { 'Read `control` and `proxy` in Zerops project project-id-1 for the console and IAM origins?': false },
		})
		await runInit({ installation: 'test' }, declined.collaborators)
		expect(declined.effects[0]).toBe('describe: project-id-1')
		expect(declined.effects).not.toContain('inspect: project-id-1')
		expect(declined.lines.join('\n')).toContain('No unverified URL was guessed')
		expect(declined.lines.join('\n')).not.toContain('export FABRIKA_IAM_RPC_URL=')
		await cleanCheckout(declined)

		const projectFailure = recorder({ answers: ANSWERS })
		const projectCollaborators: InitCollaborators = {
			...projectFailure.collaborators,
			effects: {
				...projectFailure.collaborators.effects,
				describeProject: () => Promise.reject(new Error(`private ${ACCESS_TOKEN}`)),
			},
		}
		const projectError = await runInit({ installation: 'test' }, projectCollaborators).catch((error: unknown) => error)
		expect(projectError instanceof Error ? projectError.message : '').toContain('Nothing has been created')
		expect(projectError instanceof Error ? projectError.message : '').not.toContain(ACCESS_TOKEN)
	})

	test('stops later outward effects when repository or Environment confirmation is declined', async () => {
		const repository = recorder({
			answers: ANSWERS,
			confirms: { 'Create contember/fabrika-zerops-test (private) on GitHub and push the pipeline?': false },
		})
		await runInit({ installation: 'test' }, repository.collaborators)
		expect(repository.effects).toEqual(['describe: project-id-1', 'inspect: project-id-1', 'exists: contember/fabrika-zerops-test'])
		expect(repository.lines.join('\n')).toContain('fabrika platform init --provider=zerops test')

		const environment = recorder({
			answers: ANSWERS,
			confirms: { 'Write them to the test Environment now (secret VALUES go to GitHub over `gh` stdin)?': false },
		})
		await runInit({ installation: 'test' }, environment.collaborators)
		expect(environment.effects).not.toContain('environment: test')
		expect(environment.effects.some((effect) => effect.startsWith('trigger:'))).toBe(false)
		await cleanCheckout(environment)
	})

	test('ends with the block `control key issue` needs, built from the live IAM origin and two NAMES', async () => {
		const recorded = recorder({ answers: ANSWERS })
		await runInit({ installation: 'test' }, recorded.collaborators)

		const block = recorded.lines.filter((line) => line.startsWith('action: ')).join('\n')
		expect(block).toContain(MACHINE_KEY_NEXT_STEP_TITLE)
		expect(block).toContain('export FABRIKA_IAM_RPC_URL=https://proxy-292c-8080.prg1.zerops.app')
		expect(block).toContain('FABRIKA_IAM_RPC_KEY')
		expect(block).toContain("the sidecar's `test` Environment holds the copy the pipeline uses")
		expect(block).toContain('fabrika control key issue')
		// Init has just read control's whole environment, real keys included; the block is names only.
		for (const value of [LIVE_RPC_KEY, LIVE_PROVISIONING_KEY, PROVISIONING_KEY, ACCESS_TOKEN, 'px_', 'rpc_', 'sk_']) {
			expect(recorded.lines.join('\n')).not.toContain(value)
		}
		await cleanCheckout(recorded)
	})

	test('names where to read the origin rather than guessing one it cannot verify', async () => {
		const older = recorder({ answers: ANSWERS, controlEnvironment: { FABRIKA_IAM_ISSUER: '' } })
		await runInit({ installation: 'test' }, older.collaborators)
		expect(older.lines.join('\n')).not.toContain('export FABRIKA_IAM_RPC_URL=')
		expect(older.lines.join('\n')).toContain("read from: `control`'s own FABRIKA_IAM_ISSUER")
		await cleanCheckout(older)

		const answers = {
			...ANSWERS,
			'IAM hostname': 'iam.example.com',
			'Console hostname': 'console.example.com',
			'Operations ingest hostname': 'errors.example.com',
		}
		const mismatch = recorder({ custom: true, answers, controlEnvironment: { FABRIKA_IAM_ISSUER: 'https://iam.other.example.com' } })
		await runInit({ installation: 'test' }, mismatch.collaborators)
		expect(mismatch.lines.join('\n')).not.toContain('https://iam.other.example.com')
		expect(mismatch.lines.join('\n')).not.toContain('export FABRIKA_IAM_RPC_URL=')
		await cleanCheckout(mismatch)

		const custom = recorder({ custom: true, answers })
		await runInit({ installation: 'test' }, custom.collaborators)
		expect(custom.lines.join('\n')).toContain('export FABRIKA_IAM_RPC_URL=https://iam.example.com')
		await cleanCheckout(custom)
	})

	test('refuses branch pins, local environments, extra arguments, and credential flags before effects', async () => {
		const branch = recorder({ answers: { ...ANSWERS, 'fabrika-platform tag to pin (a published tag, never a branch)': 'main' } })
		await expect(runInit({ installation: 'test' }, branch.collaborators)).rejects.toThrow('is not a published tag')
		expect(branch.effects).toEqual([])
		expect(() => checkedEnvironmentName('local')).toThrow('is refused')
		expect(parseInitArgs(['test', '--repo=acme/sidecar'])).toEqual({ installation: 'test', repo: 'acme/sidecar' })
		expect(() => parseInitArgs(['test', '--token=secret'])).toThrow('unexpected argument')
		expect(() => parseInitArgs(['test', '--repo=nope'])).toThrow('is not a <owner>/<name> repository')
	})
})

describe('reading the installation', () => {
	test('reads control and proxy and writes nothing', async () => {
		const zerops = fakeZerops({
			projectId: 'project-id-1',
			projectName: 'fabrika-test',
			services: platformServices({
				control: { FABRIKA_CONTROL_DOMAIN: 'console.example.com' },
				proxy: { zeropsSubdomain: 'https://proxy-292c-8082.prg1.zerops.app' },
			}),
		})
		const platform = await inspectPlatform('project-id-1', zerops.api, new AbortController().signal)
		expect(platform.controlEnv.get('FABRIKA_CONTROL_DOMAIN')).toBe('console.example.com')
		expect(platform.proxyEnv.get('zeropsSubdomain')).toBe('https://proxy-292c-8082.prg1.zerops.app')
		expect(platform.proxyPublished).toBe(true)
		expect(zerops.calls).toEqual([])
	})

	test('refuses a project without a control service', async () => {
		const zerops = fakeZerops({
			projectId: 'project-id-1',
			projectName: 'fabrika-test',
			services: platformServices().filter((service) => service.name !== 'control'),
		})
		await expect(inspectPlatform('project-id-1', zerops.api, new AbortController().signal)).rejects.toThrow('has no `control` service')
	})
})
