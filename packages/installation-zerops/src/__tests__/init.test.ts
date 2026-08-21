import type { EnvironmentConfig, SidecarScaffoldInput, SidecarScaffoldResult } from '@fabrika/installation-init'
import {
	buildZeropsSourceCredentialBundleV2,
	serializeZeropsSourceCredentialBundleV2,
	type ZeropsApi,
	zeropsSourceCredentialEnvV2,
} from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import {
	checkedEnvironmentName,
	classifyExistingGitHubCredentials,
	configureSourceService,
	type InitCollaborators,
	parseInitArgs,
	runInit,
	sourceConnectionSettingsUrl,
} from '../init'
import { recordingInitLog } from '../log'
import { fakeZerops, platformServices } from './fake-zerops'

const ACCESS_TOKEN = 'zerops-access-token-value-that-must-never-be-printed'
const PROVISIONING_KEY = 'px_provisioning-key-value-that-must-never-be-printed'
const APP_PEM = `-----BEGIN PRIVATE KEY-----
MAMCAQE=
-----END PRIVATE KEY-----
`
const APP_BUNDLE = serializeZeropsSourceCredentialBundleV2(
	buildZeropsSourceCredentialBundleV2({ connectionId: 'connection-1', githubAppId: '123', privateKeyPem: APP_PEM }),
)

interface Recorder {
	readonly collaborators: InitCollaborators
	readonly asked: string[]
	readonly effects: string[]
	readonly lines: readonly string[]
	readonly environments: EnvironmentConfig[]
	readonly scaffolds: SidecarScaffoldInput[]
	readonly sourceInputs: Parameters<InitCollaborators['effects']['configureSource']>[0][]
}

const recorder = (options: {
	readonly answers: Record<string, string>
	readonly confirms?: Record<string, boolean>
	readonly repositoryExists?: boolean
	readonly custom?: boolean
	readonly sourceEnvironment?: Readonly<Record<string, string>>
	readonly controlEnvironment?: Readonly<Record<string, string>>
	readonly proxyPublished?: boolean
}): Recorder => {
	const asked: string[] = []
	const effects: string[] = []
	const environments: EnvironmentConfig[] = []
	const scaffolds: SidecarScaffoldInput[] = []
	const sourceInputs: Parameters<InitCollaborators['effects']['configureSource']>[0][] = []
	const derivedControlHost = 'proxy-292c-8082.prg1.zerops.app'
	const sourceEnv = new Map([['FABRIKA_SOURCE_RPC_KEY', 'r'.repeat(32)], ...Object.entries(options.sourceEnvironment ?? {})])
	const controlEnv = new Map([
		['FABRIKA_ZEROPS_SOURCE_RPC_KEY', 'r'.repeat(32)],
		['FABRIKA_ZEROPS_PROJECT_ID', 'project-id-1'],
		['FABRIKA_CONTROL_DOMAIN', options.custom === true ? options.answers['Console hostname'] ?? '' : derivedControlHost],
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
				configureSource: async (input) => {
					sourceInputs.push(input)
					effects.push(`source: ${input.projectId}`)
					return {
						created: false,
						reusedRpcKey: true,
						writtenKeys: [],
						sourceServiceId: 'svc-source',
						controlServiceId: 'svc-control',
						proxyServiceId: 'svc-proxy',
						sourceEnv,
						controlEnv,
						proxyEnv,
						proxyPublished: options.proxyPublished ?? true,
					}
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
	test('keeps normal init anonymous and confirms only its five outward steps', async () => {
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
		expect(recorded.asked.filter((entry) => entry.startsWith('confirm: '))).toHaveLength(5)
		const transcript = recorded.lines.join('\n')
		expect(transcript).toContain('anonymous public-repository mode')
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
			FABRIKA_ZEROPS_BUILD_FROM_GIT: 'https://github.com/contember/fabrika-platform',
		})
		const transcript = recorded.lines.join('\n')
		expect(transcript).not.toContain(ACCESS_TOKEN)
		expect(transcript).not.toContain(PROVISIONING_KEY)
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

	test('reports a connected keyed slot as another Control connection, never as a credential to adopt', async () => {
		const recorded = recorder({
			answers: ANSWERS,
			sourceEnvironment: { [await zeropsSourceCredentialEnvV2('connection-1')]: APP_BUNDLE },
		})
		await runInit({ installation: 'test' }, recorded.collaborators)
		const transcript = recorded.lines.join('\n')
		expect(transcript).toContain('connect another GitHub source in Control')
		expect(transcript).not.toContain(APP_PEM)
		expect(transcript).not.toContain(APP_BUNDLE)
		await cleanCheckout(recorded)
	})

	test('ignores a leftover unkeyed or split GitHub App value instead of offering to adopt it', async () => {
		const states: ReadonlyArray<Readonly<Record<string, string>>> = [
			{ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: APP_PEM },
			{ GITHUB_APP_CREDENTIALS: APP_BUNDLE },
			{ GITHUB_APP_CREDENTIALS: 'not-json' },
		]
		for (const sourceEnvironment of states) {
			const recorded = recorder({ answers: ANSWERS, sourceEnvironment })
			await runInit({ installation: 'test' }, recorded.collaborators)
			const transcript = recorded.lines.join('\n')
			expect(transcript).toContain('connect GitHub source in Control')
			expect(transcript).not.toContain('another GitHub source')
			expect(transcript).not.toContain(APP_PEM)
			expect(transcript).not.toContain(APP_BUNDLE)
			await cleanCheckout(recorded)
		}
	})

	test('classifies remote credentials without exposing them', async () => {
		expect(classifyExistingGitHubCredentials(new Map())).toBe('anonymous')
		expect(classifyExistingGitHubCredentials(new Map([[await zeropsSourceCredentialEnvV2('connection-1'), APP_BUNDLE]]))).toBe('connected')
		expect(classifyExistingGitHubCredentials(new Map([['GITHUB_APP_CREDENTIALS', APP_BUNDLE]]))).toBe('anonymous')
		expect(classifyExistingGitHubCredentials(new Map([['GITHUB_APP_ID', '123']]))).toBe('anonymous')
		expect(sourceConnectionSettingsUrl({}, {
			created: false,
			reusedRpcKey: true,
			writtenKeys: [],
			sourceServiceId: 'source',
			controlServiceId: 'control',
			proxyServiceId: 'proxy',
			sourceEnv: new Map(),
			controlEnv: new Map([['FABRIKA_CONTROL_DOMAIN', 'user@example.com']]),
			proxyEnv: new Map(),
			proxyPublished: true,
		})).toBeUndefined()
	})

	test('redacts source and project failures and honors declined steps', async () => {
		const sourceFailure = recorder({ answers: ANSWERS })
		const sourceCollaborators: InitCollaborators = {
			...sourceFailure.collaborators,
			effects: { ...sourceFailure.collaborators.effects, configureSource: () => Promise.reject(new Error(`private ${APP_BUNDLE}`)) },
		}
		const sourceError = await runInit({ installation: 'test' }, sourceCollaborators).catch((error: unknown) => error)
		expect(sourceError instanceof Error ? sourceError.message : '').toBe(
			'source configuration did not complete; no credential value is shown. Inspect source and control in Zerops, then run init again',
		)

		const declined = recorder({ answers: ANSWERS, confirms: { 'Create or configure `source` in Zerops project project-id-1?': false } })
		await runInit({ installation: 'test' }, declined.collaborators)
		expect(declined.effects).toEqual(['describe: project-id-1'])

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
		expect(repository.effects).toEqual(['describe: project-id-1', 'source: project-id-1', 'exists: contember/fabrika-zerops-test'])
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

		expect(result).toMatchObject({ created: false, reusedRpcKey: true, writtenKeys: ['control.FABRIKA_ZEROPS_PROJECT_ID'] })
		expect(zerops.calls).toEqual(['env:control:FABRIKA_ZEROPS_PROJECT_ID'])
		expect(zerops.env('source').get('GITHUB_APP_PRIVATE_KEY')).toBe('old-key')
		expect(zerops.env('control').get('GITHUB_WEBHOOK_SECRET')).toBe('old-webhook')
	})

	test('repairs either missing side from the one valid RPC key', async () => {
		const key = 'r'.repeat(32)
		const cases: ReadonlyArray<{
			readonly env: Readonly<Record<string, Readonly<Record<string, string>>>>
			readonly writtenKey: string
		}> = [
			{ env: { source: { FABRIKA_SOURCE_RPC_KEY: key }, control: {} }, writtenKey: 'control.FABRIKA_ZEROPS_SOURCE_RPC_KEY' },
			{ env: { source: {}, control: { FABRIKA_ZEROPS_SOURCE_RPC_KEY: key } }, writtenKey: 'source.FABRIKA_SOURCE_RPC_KEY' },
		]
		for (const item of cases) {
			const zerops = fakeZerops({ projectId: 'project-id-1', projectName: 'fabrika-test', services: platformServices(item.env) })
			const result = await configureSourceService(
				{ projectId: 'project-id-1', environment: 'test' },
				zerops.api,
				async () => {},
				new AbortController().signal,
			)
			expect(result).toMatchObject({
				created: false,
				reusedRpcKey: true,
				writtenKeys: [item.writtenKey, 'control.FABRIKA_ZEROPS_PROJECT_ID'],
			})
			expect(zerops.env('source').get('FABRIKA_SOURCE_RPC_KEY')).toBe(key)
			expect(zerops.env('control').get('FABRIKA_ZEROPS_SOURCE_RPC_KEY')).toBe(key)
		}
	})

	test('uses create-only RPC writes and rejects a conflicting value injected before final reread', async () => {
		const key = 'r'.repeat(32)
		const zerops = fakeZerops({
			projectId: 'project-id-1',
			projectName: 'fabrika-test',
			services: platformServices({ source: { FABRIKA_SOURCE_RPC_KEY: key }, control: {} }),
		})
		let controlReads = 0
		const api: ZeropsApi = {
			...zerops.api,
			putServiceEnv: () => Promise.reject(new Error('update-capable RPC write was called')),
			listServiceEnv: async (input) => {
				if (input.serviceId === 'svc-control') {
					controlReads += 1
					if (controlReads === 2) zerops.env('control').set('FABRIKA_ZEROPS_SOURCE_RPC_KEY', 'x'.repeat(32))
				}
				return zerops.api.listServiceEnv(input)
			},
		}
		await expect(
			configureSourceService({ projectId: 'project-id-1', environment: 'test' }, api, async () => {}, new AbortController().signal),
		).rejects.toThrow('did not retain one matching source RPC key')
	})

	test('repairs a run that failed after writing the first generated RPC key', async () => {
		const zerops = fakeZerops({ projectId: 'project-id-1', projectName: 'fabrika-test', services: platformServices() })
		zerops.failWrite('control', 'FABRIKA_ZEROPS_SOURCE_RPC_KEY')
		await expect(
			configureSourceService({ projectId: 'project-id-1', environment: 'test' }, zerops.api, async () => {}, new AbortController().signal),
		).rejects.toThrow('source RPC configuration conflicts')
		const sourceKey = zerops.env('source').get('FABRIKA_SOURCE_RPC_KEY')
		expect(sourceKey).toBeDefined()
		expect(zerops.env('control').has('FABRIKA_ZEROPS_SOURCE_RPC_KEY')).toBe(false)
		const result = await configureSourceService(
			{ projectId: 'project-id-1', environment: 'test' },
			zerops.api,
			async () => {},
			new AbortController().signal,
		)
		expect(result).toMatchObject({
			created: false,
			reusedRpcKey: true,
			writtenKeys: ['control.FABRIKA_ZEROPS_SOURCE_RPC_KEY', 'control.FABRIKA_ZEROPS_PROJECT_ID'],
		})
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
				configureSourceService({ projectId: 'project-id-1', environment: 'test' }, zerops.api, async () => {}, new AbortController().signal),
			).rejects.toThrow('refusing to rotate either side')
			expect(zerops.calls).toEqual([])
		}
	})

	test('does not change GitHub credentials while ensuring the source RPC transport', async () => {
		const key = 'r'.repeat(32)
		const zerops = fakeZerops({
			projectId: 'project-id-1',
			projectName: 'fabrika-test',
			services: platformServices({ source: { FABRIKA_SOURCE_RPC_KEY: key }, control: { FABRIKA_ZEROPS_SOURCE_RPC_KEY: key } }),
		})
		await configureSourceService(
			{ projectId: 'project-id-1', environment: 'test' },
			zerops.api,
			async () => {},
			new AbortController().signal,
		)
		expect(zerops.env('source').has('GITHUB_APP_ID')).toBe(false)
		expect(zerops.env('source').has('GITHUB_APP_PRIVATE_KEY')).toBe(false)
		expect(zerops.env('source').has('GITHUB_WEBHOOK_SECRET')).toBe(false)
		expect(zerops.env('control').has('GITHUB_WEBHOOK_SECRET')).toBe(false)
		expect(zerops.env('control').has('GITHUB_APP_PRIVATE_KEY')).toBe(false)
	})
})
