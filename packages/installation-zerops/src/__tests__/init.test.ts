import type { EnvironmentConfig, SidecarScaffoldInput, SidecarScaffoldResult } from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { checkedEnvironmentName, configureSourceService, type InitCollaborators, parseInitArgs, runInit } from '../init'
import { recordingInitLog } from '../log'
import { fakeZerops, platformServices } from './fake-zerops'

const ACCESS_TOKEN = 'zerops-access-token-value-that-must-never-be-printed'
const PROVISIONING_KEY = 'px_provisioning-key-value-that-must-never-be-printed'

interface Recorder {
	readonly collaborators: InitCollaborators
	readonly asked: string[]
	readonly effects: string[]
	readonly lines: readonly string[]
	readonly environments: EnvironmentConfig[]
	readonly scaffolds: SidecarScaffoldInput[]
	readonly sourceInputs: Parameters<InitCollaborators['effects']['configureSource']>[0][]
}

/**
 * Every seam faked: no TTY, no `gh`, no git, no network. What is asserted is the ORDER of the questions
 * and effects, and — as loudly — what never reaches the transcript.
 */
const recorder = (options: {
	readonly answers: Record<string, string>
	readonly confirms?: Record<string, boolean>
	readonly repositoryExists?: boolean
	readonly custom?: boolean
}): Recorder => {
	const asked: string[] = []
	const effects: string[] = []
	const environments: EnvironmentConfig[] = []
	const scaffolds: SidecarScaffoldInput[] = []
	const sourceInputs: Parameters<InitCollaborators['effects']['configureSource']>[0][] = []
	const log = recordingInitLog()
	return {
		asked,
		effects,
		environments,
		scaffolds,
		sourceInputs,
		lines: log.lines,
		collaborators: {
			log,
			prompts: {
				text: async (question, fallback) => {
					asked.push(`text: ${question}`)
					return options.answers[question] ?? fallback ?? ''
				},
				setting: async (variable, question, fallback) => {
					asked.push(`setting: ${variable}`)
					return options.answers[question] ?? fallback ?? ''
				},
				confirm: async (question, defaultYes) => {
					asked.push(`confirm: ${question}`)
					return options.confirms?.[question] ?? defaultYes ?? false
				},
				select: async (question, choices) => {
					asked.push(`select: ${question}`)
					const chosen = choices[options.custom === true ? 1 : 0]
					if (chosen === undefined) {
						throw new Error('no option')
					}
					return chosen.value
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
				configureSource: async (input) => {
					sourceInputs.push(input)
					const { projectId } = input
					effects.push(`source: ${projectId}`)
					return { created: false, reusedRpcKey: true, writtenKeys: [] }
				},
			},
		},
	}
}

const ANSWERS = {
	'fabrika-platform tag to pin (a published tag, never a branch)': 'v0.1.0',
	'Zerops project id (the project holding iam, operations, proxy and control)': 'project-id-1',
}

/** The scaffold is faked, so nothing is written — but `materialize` is real and would write if called. */
const cleanCheckout = async (recorded: Recorder): Promise<void> => {
	for (const scaffold of recorded.scaffolds) {
		await rm(scaffold.dir, { recursive: true, force: true })
	}
}

describe('fabrika platform init --provider=zerops', () => {
	test('every outward step is confirmed, in order, after everything local is collected', async () => {
		const recorded = recorder({ answers: ANSWERS })

		await runInit({ installation: 'test' }, recorded.collaborators)

		expect(recorded.effects).toEqual([
			'describe: project-id-1',
			'source: project-id-1',
			'exists: contember/fabrika-zerops-test',
			'scaffold: contember/fabrika-zerops-test',
			'environment: test',
			'trigger: contember/fabrika-zerops-test',
		])
		const confirmations = recorded.asked.filter((entry) => entry.startsWith('confirm: '))
		expect(confirmations).toHaveLength(5)
		expect(confirmations[0]).toContain('Read Zerops project project-id-1')
		expect(confirmations[1]).toContain('Create or configure `source`')
		expect(confirmations[2]).toContain('Create contember/fabrika-zerops-test (private) on GitHub')
		expect(confirmations[3]).toContain('Write them to the test Environment now')
		expect(confirmations[4]).toContain('Run the platform workflow')
		await cleanCheckout(recorded)
	})

	test('the Environment carries exactly the two credentials and the deploy configuration', async () => {
		const recorded = recorder({ answers: ANSWERS })

		await runInit({ installation: 'test' }, recorded.collaborators)

		const written = recorded.environments[0]
		expect(written?.repo).toBe('contember/fabrika-zerops-test')
		expect(written?.environment).toBe('test')
		expect(Object.keys(written?.secrets ?? {})).toEqual(['FABRIKA_ZEROPS_ACCESS_TOKEN', 'FABRIKA_IAM_PROVISIONING_KEY'])
		expect(written?.vars).toEqual({
			FABRIKA_ZEROPS_PROJECT_ID: 'project-id-1',
			FABRIKA_PLATFORM_ENVIRONMENT: 'test',
			FABRIKA_PLATFORM_SCHEME: 'https',
			FABRIKA_ZEROPS_BUILD_FROM_GIT: 'https://github.com/contember/fabrika-platform',
		})
		// A derived-host installation names no host: the deploy reads them off the proxy's subdomains.
		expect(Object.keys(written?.vars ?? {})).not.toContain('FABRIKA_PLATFORM_IAM_HOST')
		// And no admission list of any kind — nothing here has to be closed off later.
		for (const name of Object.keys({ ...written?.secrets, ...written?.vars })) {
			expect(name).not.toContain('BOOTSTRAP')
		}
		await cleanCheckout(recorded)
	})

	test('a custom-domain installation names all three hosts', async () => {
		const recorded = recorder({
			custom: true,
			answers: {
				...ANSWERS,
				'IAM hostname': 'iam.example.com',
				'Console hostname': 'console.example.com',
				'Operations ingest hostname': 'errors.example.com',
			},
		})

		await runInit({ installation: 'test' }, recorded.collaborators)

		expect(recorded.environments[0]?.vars).toMatchObject({
			FABRIKA_PLATFORM_IAM_HOST: 'iam.example.com',
			FABRIKA_PLATFORM_CONSOLE_HOST: 'console.example.com',
			FABRIKA_PLATFORM_OPERATIONS_HOST: 'errors.example.com',
		})
		await cleanCheckout(recorded)
	})

	test('NO secret value reaches the transcript — only the names', async () => {
		const recorded = recorder({ answers: ANSWERS })

		await runInit({ installation: 'test' }, recorded.collaborators)

		const transcript = recorded.lines.join('\n')
		expect(transcript).not.toContain(ACCESS_TOKEN)
		expect(transcript).not.toContain(PROVISIONING_KEY)
		expect(transcript).toContain('FABRIKA_ZEROPS_ACCESS_TOKEN')
		expect(transcript).toContain('FABRIKA_IAM_PROVISIONING_KEY')
		await cleanCheckout(recorded)
	})

	test('sends optional source settings only to Zerops and not the GitHub Environment', async () => {
		const appKey = 'private-key-that-must-never-be-printed'
		const webhook = 'webhook-secret-that-must-never-be-printed'
		const recorded = recorder({
			answers: {
				...ANSWERS,
				'GitHub App id for private repositories (blank = anonymous public mode)': '123',
				GITHUB_APP_PRIVATE_KEY: appKey,
				GITHUB_WEBHOOK_SECRET: webhook,
			},
		})
		const collaborators: InitCollaborators = {
			...recorded.collaborators,
			prompts: {
				...recorded.collaborators.prompts,
				secret: async (variable, question) => {
					if (variable === 'GITHUB_APP_PRIVATE_KEY') return appKey
					if (variable === 'GITHUB_WEBHOOK_SECRET') return webhook
					return recorded.collaborators.prompts.secret(variable, question)
				},
			},
		}

		await runInit({ installation: 'test' }, collaborators)

		expect(recorded.sourceInputs[0]).toMatchObject({
			githubAppId: '123',
			githubAppPrivateKey: appKey,
			githubWebhookSecret: webhook,
		})
		expect(JSON.stringify(recorded.environments[0])).not.toContain(appKey)
		expect(JSON.stringify(recorded.environments[0])).not.toContain(webhook)
		const transcript = recorded.lines.join('\n')
		expect(transcript).not.toContain(appKey)
		expect(transcript).not.toContain(webhook)
		await cleanCheckout(recorded)
	})

	test('redacts a source configuration failure before it reaches the operator', async () => {
		const sentinel = 'private-source-error-body'
		const recorded = recorder({ answers: ANSWERS })
		const collaborators: InitCollaborators = {
			...recorded.collaborators,
			effects: {
				...recorded.collaborators.effects,
				configureSource: () => Promise.reject(new Error(sentinel)),
			},
		}

		const raised = await runInit({ installation: 'test' }, collaborators).then(() => undefined, (error: unknown) => error)
		expect(raised).toBeInstanceOf(Error)
		expect(raised instanceof Error ? raised.message : sentinel).not.toContain(sentinel)
		expect(raised instanceof Error ? raised.message : '').toContain('source configuration did not complete')
	})

	test('declining the repository stops there and says what to run', async () => {
		const recorded = recorder({
			answers: ANSWERS,
			confirms: { 'Create contember/fabrika-zerops-test (private) on GitHub and push the pipeline?': false },
		})

		await runInit({ installation: 'test' }, recorded.collaborators)

		expect(recorded.effects).toEqual(['describe: project-id-1', 'source: project-id-1', 'exists: contember/fabrika-zerops-test'])
		expect(recorded.lines.join('\n')).toContain('fabrika platform init --provider=zerops test --repo=contember/fabrika-zerops-test')
	})

	test('declining the Environment write never triggers a run that would fail without it', async () => {
		const recorded = recorder({
			answers: ANSWERS,
			confirms: { 'Write them to the test Environment now (secret VALUES go to GitHub over `gh` stdin)?': false },
		})

		await runInit({ installation: 'test' }, recorded.collaborators)

		expect(recorded.effects).not.toContain('environment: test')
		expect(recorded.effects.some((effect) => effect.startsWith('trigger:'))).toBe(false)
		await cleanCheckout(recorded)
	})

	test('an unreadable project stops init with a sentence, never with the raw error', async () => {
		const recorded = recorder({ answers: ANSWERS })
		const failing: InitCollaborators = {
			...recorded.collaborators,
			effects: {
				...recorded.collaborators.effects,
				describeProject: () => Promise.reject(new Error(`GET https://api.example/project?token=${ACCESS_TOKEN} failed`)),
			},
		}

		const raised = await runInit({ installation: 'test' }, failing).then(() => undefined, (error: unknown) => error)
		expect(raised).toBeInstanceOf(Error)
		expect(raised instanceof Error ? raised.message : '').toContain('Nothing has been created')
		expect(raised instanceof Error ? raised.message : ACCESS_TOKEN).not.toContain(ACCESS_TOKEN)
	})

	test('a branch pin is refused before anything leaves the disk', async () => {
		const recorded = recorder({
			answers: { ...ANSWERS, 'fabrika-platform tag to pin (a published tag, never a branch)': 'main' },
		})

		await expect(runInit({ installation: 'test' }, recorded.collaborators)).rejects.toThrow('is not a published tag')
		expect(recorded.effects).toEqual([])
	})

	test('`local` is refused as an installation environment name', () => {
		expect(() => checkedEnvironmentName('local')).toThrow('is refused')
		expect(() => checkedEnvironmentName('  ')).toThrow('required')
		expect(checkedEnvironmentName(' test ')).toBe('test')
	})

	test('the arguments name one installation and, optionally, one repository', () => {
		expect(parseInitArgs(['test'])).toEqual({ installation: 'test' })
		expect(parseInitArgs(['test', '--repo=acme/sidecar'])).toEqual({ installation: 'test', repo: 'acme/sidecar' })
		expect(() => parseInitArgs([])).toThrow('requires an installation name')
		expect(() => parseInitArgs(['test', 'other'])).toThrow('name ONE installation')
		expect(() => parseInitArgs(['test', '--token=secret'])).toThrow('unexpected argument')
		expect(() => parseInitArgs(['test', '--repo=nope'])).toThrow('is not a <owner>/<name> repository')
	})
})

describe('the supported source-service upgrade', () => {
	test('imports only missing source with the steady document, waits, and places one shared RPC key', async () => {
		const source = { name: 'source', id: 'svc-source', importProcesses: 2 }
		const zerops = fakeZerops({
			projectId: 'project-id-1',
			projectName: 'fabrika-test',
			services: platformServices().filter((service) => service.name !== 'source'),
			bootstrap: { clientId: 'client-1', imported: [source] },
		})
		const result = await configureSourceService(
			{ projectId: 'project-id-1', environment: 'test' },
			zerops.api,
			async () => {},
			new AbortController().signal,
		)

		expect(result).toMatchObject({ created: true, reusedRpcKey: false })
		expect(zerops.imports).toHaveLength(1)
		expect(zerops.imports[0]).toContain('hostname: source')
		expect(zerops.imports[0]).not.toContain('hostname: control')
		expect(zerops.imports[0]).toContain('startWithoutCode: true')
		expect(zerops.importedProcesses).toHaveLength(2)
		expect(zerops.timeline.indexOf('process:process-import-source-1')).toBeLessThan(zerops.timeline.indexOf('env:source:FABRIKA_SOURCE_RPC_KEY'))
		const sourceKey = zerops.env('source').get('FABRIKA_SOURCE_RPC_KEY')
		expect(sourceKey).toBeDefined()
		expect(zerops.env('control').get('FABRIKA_ZEROPS_SOURCE_RPC_KEY')).toBe(sourceKey)
		expect(zerops.env('source').has('FABRIKA_ZEROPS_ACCESS_TOKEN')).toBe(false)
	})

	test('reuses a matching valid key and preserves omitted App and webhook credentials', async () => {
		const key = 'r'.repeat(32)
		const zerops = fakeZerops({
			projectId: 'project-id-1',
			projectName: 'fabrika-test',
			services: platformServices({
				source: { FABRIKA_SOURCE_RPC_KEY: key, GITHUB_APP_ID: 'old-app', GITHUB_APP_PRIVATE_KEY: 'old-key' },
				control: { FABRIKA_ZEROPS_SOURCE_RPC_KEY: key, GITHUB_WEBHOOK_SECRET: 'old-webhook' },
			}),
		})
		const result = await configureSourceService(
			{ projectId: 'project-id-1', environment: 'test' },
			zerops.api,
			async () => {},
			new AbortController().signal,
		)

		expect(result).toEqual({ created: false, reusedRpcKey: true, writtenKeys: [] })
		expect(zerops.calls).toEqual([])
		expect(zerops.env('source').get('GITHUB_APP_PRIVATE_KEY')).toBe('old-key')
		expect(zerops.env('control').get('GITHUB_WEBHOOK_SECRET')).toBe('old-webhook')
	})

	test('repairs either missing side from the one valid RPC key', async () => {
		const key = 'r'.repeat(32)
		const cases: ReadonlyArray<{
			readonly env: Readonly<Record<string, Readonly<Record<string, string>>>>
			readonly writtenKey: string
		}> = [
			{
				env: { source: { FABRIKA_SOURCE_RPC_KEY: key }, control: {} },
				writtenKey: 'control.FABRIKA_ZEROPS_SOURCE_RPC_KEY',
			},
			{
				env: { source: {}, control: { FABRIKA_ZEROPS_SOURCE_RPC_KEY: key } },
				writtenKey: 'source.FABRIKA_SOURCE_RPC_KEY',
			},
		]
		for (const item of cases) {
			const zerops = fakeZerops({ projectId: 'project-id-1', projectName: 'fabrika-test', services: platformServices(item.env) })
			const result = await configureSourceService(
				{ projectId: 'project-id-1', environment: 'test' },
				zerops.api,
				async () => {},
				new AbortController().signal,
			)

			expect(result).toEqual({ created: false, reusedRpcKey: true, writtenKeys: [item.writtenKey] })
			expect(zerops.env('source').get('FABRIKA_SOURCE_RPC_KEY')).toBe(key)
			expect(zerops.env('control').get('FABRIKA_ZEROPS_SOURCE_RPC_KEY')).toBe(key)
		}
	})

	test('repairs a run that failed after writing the first generated RPC key', async () => {
		const zerops = fakeZerops({ projectId: 'project-id-1', projectName: 'fabrika-test', services: platformServices() })
		zerops.failWrite('control', 'FABRIKA_ZEROPS_SOURCE_RPC_KEY')
		await expect(
			configureSourceService(
				{ projectId: 'project-id-1', environment: 'test' },
				zerops.api,
				async () => {},
				new AbortController().signal,
			),
		).rejects.toThrow('create service env failed')

		const sourceKey = zerops.env('source').get('FABRIKA_SOURCE_RPC_KEY')
		expect(sourceKey).toBeDefined()
		expect(zerops.env('control').has('FABRIKA_ZEROPS_SOURCE_RPC_KEY')).toBe(false)

		const result = await configureSourceService(
			{ projectId: 'project-id-1', environment: 'test' },
			zerops.api,
			async () => {},
			new AbortController().signal,
		)

		expect(result).toEqual({ created: false, reusedRpcKey: true, writtenKeys: ['control.FABRIKA_ZEROPS_SOURCE_RPC_KEY'] })
		expect(zerops.env('control').get('FABRIKA_ZEROPS_SOURCE_RPC_KEY')).toBe(sourceKey)
	})

	test('refuses a mismatched or invalid RPC key without writing either side', async () => {
		const environments: ReadonlyArray<Readonly<Record<string, Readonly<Record<string, string>>>>> = [
			{ source: { FABRIKA_SOURCE_RPC_KEY: 'a'.repeat(32) }, control: { FABRIKA_ZEROPS_SOURCE_RPC_KEY: 'b'.repeat(32) } },
			{ source: { FABRIKA_SOURCE_RPC_KEY: 'short' }, control: {} },
			{ source: {}, control: { FABRIKA_ZEROPS_SOURCE_RPC_KEY: 'short' } },
		]
		for (const env of environments) {
			const zerops = fakeZerops({ projectId: 'project-id-1', projectName: 'fabrika-test', services: platformServices(env) })
			await expect(
				configureSourceService(
					{ projectId: 'project-id-1', environment: 'test' },
					zerops.api,
					async () => {},
					new AbortController().signal,
				),
			).rejects.toThrow('refusing to rotate either side')
			expect(zerops.calls).toEqual([])
		}
	})

	test('places optional credentials only on their owning service', async () => {
		const key = 'r'.repeat(32)
		const zerops = fakeZerops({
			projectId: 'project-id-1',
			projectName: 'fabrika-test',
			services: platformServices({ source: { FABRIKA_SOURCE_RPC_KEY: key }, control: { FABRIKA_ZEROPS_SOURCE_RPC_KEY: key } }),
		})
		await configureSourceService(
			{
				projectId: 'project-id-1',
				environment: 'test',
				githubAppId: '123',
				githubAppPrivateKey: 'private-key',
				githubWebhookSecret: 'webhook-secret',
			},
			zerops.api,
			async () => {},
			new AbortController().signal,
		)
		expect(zerops.env('source').get('GITHUB_APP_ID')).toBe('123')
		expect(zerops.env('source').get('GITHUB_APP_PRIVATE_KEY')).toBe('private-key')
		expect(zerops.env('source').has('GITHUB_WEBHOOK_SECRET')).toBe(false)
		expect(zerops.env('control').get('GITHUB_WEBHOOK_SECRET')).toBe('webhook-secret')
		expect(zerops.env('control').has('GITHUB_APP_PRIVATE_KEY')).toBe(false)
	})
})
