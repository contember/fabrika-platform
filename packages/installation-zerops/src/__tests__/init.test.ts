import type { EnvironmentConfig, SidecarScaffoldInput, SidecarScaffoldResult } from '@fabrika/installation-init'
import type { ZeropsApi } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import type { GitHubAppRecovery, GitHubAppRecoveryLock } from '../github-app-recovery'
import { checkedEnvironmentName, configureSourceService, type InitCollaborators, parseGitHubRepositories, parseInitArgs, runInit } from '../init'
import { recordingInitLog } from '../log'
import { fakeZerops, platformServices } from './fake-zerops'

const ACCESS_TOKEN = 'zerops-access-token-value-that-must-never-be-printed'
const PROVISIONING_KEY = 'px_provisioning-key-value-that-must-never-be-printed'
const APP_PEM = `-----BEGIN PRIVATE KEY-----
ZmFrZQ==
-----END PRIVATE KEY-----`

interface Recorder {
	readonly collaborators: InitCollaborators
	readonly asked: string[]
	readonly effects: string[]
	readonly lines: readonly string[]
	readonly environments: EnvironmentConfig[]
	readonly scaffolds: SidecarScaffoldInput[]
	readonly sourceInputs: Parameters<InitCollaborators['effects']['configureSource']>[0][]
	readonly selectOptions: Array<{ readonly question: string; readonly labels: readonly string[] }>
	readonly sourceEnv: Map<string, string>
	readonly controlEnv: Map<string, string>
	hasRecovery(): boolean
	resumeReads(): void
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
	readonly appMode?: 'anonymous' | 'existing' | 'create'
	readonly appOwner?: string
	readonly appPublic?: boolean
	readonly sourceEnvironment?: Readonly<Record<string, string>>
	readonly controlEnvironment?: Readonly<Record<string, string>>
	readonly installedRepositories?: readonly string[]
	readonly recovery?: GitHubAppRecovery
	readonly proxyPublished?: boolean
	readonly crashAfterWriteKey?: string
	readonly ambiguousWriteKey?: string
	readonly delayedVisibility?: { readonly key: string; readonly reads: number }
	readonly conflictAfterCompleteSourceReads?: number
}): Recorder => {
	const asked: string[] = []
	const effects: string[] = []
	const environments: EnvironmentConfig[] = []
	const scaffolds: SidecarScaffoldInput[] = []
	const sourceInputs: Parameters<InitCollaborators['effects']['configureSource']>[0][] = []
	const selectOptions: Array<{ readonly question: string; readonly labels: readonly string[] }> = []
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
	let recovery: GitHubAppRecovery | undefined = options.recovery
	let readsBlocked = false
	let delayedWrite: { readonly serviceId: string; readonly key: string; readonly value: string; remaining: number } | undefined
	let completeSourceReads = 0
	const recoveryLock: GitHubAppRecoveryLock = {
		hasRecovery: () => Promise.resolve(recovery !== undefined),
		read: () => Promise.resolve(recovery),
		write: (value) => {
			recovery = value
			return Promise.resolve()
		},
		delete: (_binding, credentials) => {
			if (recovery !== undefined && JSON.stringify(recovery.app) !== JSON.stringify(credentials)) throw new Error('recovery mismatch')
			recovery = undefined
			effects.push('recovery-delete')
			return Promise.resolve()
		},
		release: () => Promise.resolve(),
	}
	const log = recordingInitLog()
	return {
		asked,
		effects,
		sourceEnv,
		controlEnv,
		hasRecovery: () => recovery !== undefined,
		resumeReads: () => void (readsBlocked = false),
		environments,
		scaffolds,
		sourceInputs,
		selectOptions,
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
					selectOptions.push({ question, labels: choices.map((choice) => choice.label) })
					const index = question === 'Where does this installation answer?'
						? options.custom === true ? 1 : 0
						: options.appMode === 'existing'
						? 1
						: options.appMode === 'create'
						? 0
						: 2
					const chosen = choices[index]
					if (chosen === undefined) {
						throw new Error('no option')
					}
					return chosen.value
				},
				secret: async (variable) => {
					asked.push(`secret: ${variable}`)
					if (variable === 'FABRIKA_ZEROPS_ACCESS_TOKEN') return ACCESS_TOKEN
					if (variable === 'FABRIKA_IAM_PROVISIONING_KEY') return PROVISIONING_KEY
					if (variable === 'GITHUB_APP_PRIVATE_KEY') return APP_PEM
					if (variable === 'GITHUB_WEBHOOK_SECRET') return 'webhook-secret'
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
				readServiceEnvironment: async ({ serviceId }) => {
					if (readsBlocked) throw new Error('simulated process crash after remote write')
					const environment = serviceId === 'svc-source' ? sourceEnv : controlEnv
					if (
						serviceId === 'svc-source' && sourceEnv.has('GITHUB_APP_ID') && sourceEnv.has('GITHUB_APP_PRIVATE_KEY')
						&& controlEnv.has('GITHUB_WEBHOOK_SECRET')
					) {
						completeSourceReads += 1
						if (completeSourceReads === options.conflictAfterCompleteSourceReads) sourceEnv.set('GITHUB_APP_ID', '999')
					}
					if (delayedWrite?.serviceId === serviceId) {
						if (delayedWrite.remaining === 0) {
							environment.set(delayedWrite.key, delayedWrite.value)
							delayedWrite = undefined
						} else {
							delayedWrite.remaining -= 1
						}
					}
					return new Map(environment)
				},
				createServiceEnvironment: async ({ serviceId, key, value }) => {
					if (key === options.delayedVisibility?.key) {
						delayedWrite = { serviceId, key, value, remaining: options.delayedVisibility.reads }
					} else {
						;(serviceId === 'svc-source' ? sourceEnv : controlEnv).set(key, value)
					}
					if (key === options.crashAfterWriteKey) readsBlocked = true
					if (key === options.ambiguousWriteKey) throw new Error('upstream response was lost with private detail')
				},
				sleep: async (ms) => void effects.push(`sleep:${ms}`),
				acquireRecovery: () => Promise.resolve(recoveryLock),
				createGitHubApp: async (input, onCreated) => {
					effects.push(`create-app:${input.organization}:${input.public}`)
					const app = {
						id: 123,
						slug: 'fabrika-test',
						htmlUrl: 'https://github.com/apps/fabrika-test',
						pem: APP_PEM,
						webhookSecret: 'webhook-secret',
					}
					await onCreated(app, new AbortController().signal)
					return app
				},
				createGitHubClient: async () => ({
					getAuthenticatedApp: async () => ({
						id: 123,
						slug: 'fabrika-test',
						htmlUrl: 'https://github.com/apps/fabrika-test',
						public: options.appPublic ?? false,
						permissions: { contents: 'read' },
						events: ['push'],
						owner: { login: options.appOwner ?? 'contember', type: 'Organization' },
					}),
					updateWebhookConfig: async ({ url }) => {
						effects.push(`webhook:${url}`)
						return { url, contentType: 'json', insecureSsl: '0' }
					},
					getWebhookConfig: async () => ({
						url: `https://${options.custom === true ? options.answers['Console hostname'] ?? '' : derivedControlHost}/webhooks/github`,
						contentType: 'json',
						insecureSsl: '0',
					}),
					resolveOrganizationInstallationId: async (organization) => {
						effects.push(`verify-org:${organization}`)
						return options.installedRepositories?.some((item) => item.toLowerCase() === organization.toLowerCase()) === true ? 76 : null
					},
					resolveInstallationId: async (owner, repository) => {
						effects.push(`verify-repo:${owner}/${repository}`)
						return options.installedRepositories?.some((item) => item.toLowerCase() === `${owner}/${repository}`.toLowerCase()) === true ? 77 : null
					},
				}),
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

	test('declining source configuration stops before scaffold, Environment, and workflow effects', async () => {
		const recorded = recorder({
			answers: ANSWERS,
			confirms: { 'Create or configure `source` in Zerops project project-id-1?': false },
		})
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.effects).toEqual(['describe: project-id-1'])
		expect(recorded.effects.some((effect) => effect.startsWith('exists:'))).toBe(false)
		expect(recorded.effects.some((effect) => effect.startsWith('environment:'))).toBe(false)
		expect(recorded.effects.some((effect) => effect.startsWith('trigger:'))).toBe(false)
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

	test('parses, canonicalizes, and deduplicates requested GitHub repositories', () => {
		expect(parseGitHubRepositories('Contember/Fabrika, contember/fabrika, other/app')).toEqual([
			{ owner: 'Contember', repository: 'Fabrika' },
			{ owner: 'other', repository: 'app' },
		])
		expect(() => parseGitHubRepositories('../owner/repo')).toThrow('not a GitHub')
		expect(() => parseGitHubRepositories('_owner/repo')).toThrow('not a GitHub')
	})

	test('creates a private same-organization App, persists before writes, and verifies every requested repository', async () => {
		const recorded = recorder({
			appMode: 'create',
			appOwner: 'contember',
			answers: {
				...ANSWERS,
				'Application repositories the GitHub App must access (comma-separated owner/repo; blank = none)': 'contember/app, contember/other',
				'GitHub organization that will own the App': 'contember',
				'GitHub App name': 'fabrika-test',
			},
			confirms: { 'Has the GitHub App been installed with the requested access?': true },
			installedRepositories: ['contember/app', 'contember/other'],
		})
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.effects).toContain('create-app:contember:false')
		expect(recorded.sourceEnv.get('GITHUB_APP_PRIVATE_KEY')).toBe(APP_PEM)
		expect(recorded.sourceEnv.get('GITHUB_APP_ID')).toBe('123')
		expect(recorded.controlEnv.get('GITHUB_WEBHOOK_SECRET')).toBe('webhook-secret')
		expect(recorded.effects.filter((effect) => effect.startsWith('verify-repo:'))).toEqual([
			'verify-repo:contember/app',
			'verify-repo:contember/other',
		])
		expect(recorded.lines.join('\n')).not.toContain(APP_PEM)
		await cleanCheckout(recorded)
	})

	test('does not offer anonymous mode when repository access was requested', async () => {
		const recorded = recorder({
			appMode: 'create',
			appOwner: 'contember',
			answers: {
				...ANSWERS,
				'Application repositories the GitHub App must access (comma-separated owner/repo; blank = none)': 'contember/app',
				'GitHub organization that will own the App': 'contember',
				'GitHub App name': 'fabrika-test',
			},
			confirms: { 'Has the GitHub App been installed with the requested access?': true },
			installedRepositories: ['contember/app'],
		})
		await runInit({ installation: 'test' }, recorded.collaborators)
		const modeSelection = recorded.selectOptions.find((selection) => selection.question === 'How should source access GitHub repositories?')
		expect(modeSelection?.labels).toEqual([
			'Create an organization-owned GitHub App',
			'Use an existing organization-owned GitHub App',
		])
		await cleanCheckout(recorded)
	})

	test('accepts a complete existing App bundle and never invokes manifest creation', async () => {
		const recorded = recorder({
			appMode: 'existing',
			appOwner: 'contember',
			answers: { ...ANSWERS, 'Existing GitHub App id': '123' },
			confirms: { 'Has the GitHub App been installed with the requested access?': true },
			installedRepositories: ['contember'],
		})
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.effects.some((effect) => effect.startsWith('create-app:'))).toBe(false)
		expect(recorded.sourceEnv.get('GITHUB_APP_ID')).toBe('123')
		expect(recorded.sourceEnv.get('GITHUB_APP_PRIVATE_KEY')).toBe(APP_PEM)
		expect(recorded.controlEnv.get('GITHUB_WEBHOOK_SECRET')).toBe('webhook-secret')
		await cleanCheckout(recorded)
	})

	test('requires an explicit public choice for cross-organization creation', async () => {
		const declined = recorder({
			appMode: 'create',
			answers: {
				...ANSWERS,
				'Application repositories the GitHub App must access (comma-separated owner/repo; blank = none)': 'other/app',
				'GitHub organization that will own the App': 'contember',
			},
			confirms: { 'Requested repositories cross organization boundaries. Create a PUBLIC GitHub App?': false },
		})
		await expect(runInit({ installation: 'test' }, declined.collaborators)).rejects.toThrow('configuration did not complete')
		expect(declined.effects.some((effect) => effect.startsWith('create-app:'))).toBe(false)
		const accepted = recorder({
			appMode: 'create',
			appPublic: true,
			answers: {
				...ANSWERS,
				'Application repositories the GitHub App must access (comma-separated owner/repo; blank = none)': 'other/app',
				'GitHub organization that will own the App': 'contember',
				'GitHub App name': 'fabrika-test',
			},
			confirms: {
				'Requested repositories cross organization boundaries. Create a PUBLIC GitHub App?': true,
				'Has the GitHub App been installed with the requested access?': true,
			},
			installedRepositories: ['other/app'],
		})
		await runInit({ installation: 'test' }, accepted.collaborators)
		expect(accepted.effects).toContain('create-app:contember:true')
		await cleanCheckout(accepted)
	})

	test('preserves a complete live App and repeats installation verification without manifest creation', async () => {
		const recorded = recorder({
			appOwner: 'contember',
			answers: {
				...ANSWERS,
				'Application repositories the GitHub App must access (comma-separated owner/repo; blank = none)': 'contember/app',
			},
			sourceEnvironment: { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: APP_PEM },
			controlEnvironment: { GITHUB_WEBHOOK_SECRET: 'webhook-secret' },
			confirms: { 'Has the GitHub App been installed with the requested access?': true },
			installedRepositories: ['contember/app'],
		})
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.effects.some((effect) => effect.startsWith('create-app:'))).toBe(false)
		expect(recorded.effects).toContain('verify-repo:contember/app')
		await cleanCheckout(recorded)
	})

	test('requires an organization installation when an App has no requested repository yet', async () => {
		const recorded = recorder({
			appMode: 'create',
			appOwner: 'contember',
			answers: { ...ANSWERS, 'GitHub organization that will own the App': 'contember', 'GitHub App name': 'fabrika-test' },
			confirms: { 'Has the GitHub App been installed with the requested access?': true },
			installedRepositories: ['contember'],
		})
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.effects).toContain('verify-org:contember')
		await cleanCheckout(recorded)
	})

	test('does not let a declined App installation confirmation bypass the same check on rerun', async () => {
		const confirms: Record<string, boolean> = { 'Has the GitHub App been installed with the requested access?': false }
		const recorded = recorder({
			answers: ANSWERS,
			confirms,
			appOwner: 'contember',
			sourceEnvironment: { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: APP_PEM },
			controlEnvironment: { GITHUB_WEBHOOK_SECRET: 'webhook-secret' },
			installedRepositories: ['contember'],
		})
		await expect(runInit({ installation: 'test' }, recorded.collaborators)).rejects.toThrow('installation verification did not complete')
		expect(recorded.effects).not.toContain('verify-org:contember')
		expect(recorded.hasRecovery()).toBe(false)
		expect(recorded.effects).toContain('recovery-delete')
		confirms['Has the GitHub App been installed with the requested access?'] = true
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.asked.filter((question) => question === 'confirm: Has the GitHub App been installed with the requested access?')).toHaveLength(2)
		expect(recorded.effects).toContain('verify-org:contember')
		await cleanCheckout(recorded)
	})

	test('refuses a private App for cross-organization repositories before changing its webhook', async () => {
		const recorded = recorder({
			appOwner: 'contember',
			answers: {
				...ANSWERS,
				'Application repositories the GitHub App must access (comma-separated owner/repo; blank = none)': 'other/app',
			},
			sourceEnvironment: { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: APP_PEM },
			controlEnvironment: { GITHUB_WEBHOOK_SECRET: 'webhook-secret' },
		})
		await expect(runInit({ installation: 'test' }, recorded.collaborators)).rejects.toThrow('configuration did not complete')
		expect(recorded.effects.some((effect) => effect.startsWith('webhook:'))).toBe(false)
	})

	test('fails closed on partial live App state before creating or writing credentials', async () => {
		const recorded = recorder({ answers: ANSWERS, sourceEnvironment: { GITHUB_APP_ID: '123' } })
		await expect(runInit({ installation: 'test' }, recorded.collaborators)).rejects.toThrow('configuration did not complete')
		expect(recorded.effects.some((effect) => effect.startsWith('create-app:'))).toBe(false)
		expect(recorded.sourceEnv.has('GITHUB_APP_PRIVATE_KEY')).toBe(false)
	})

	test('refuses a mismatched custom origin and an unpublished derived proxy before GitHub mutation', async () => {
		const mismatch = recorder({
			appMode: 'create',
			custom: true,
			answers: {
				...ANSWERS,
				'IAM hostname': 'iam.example.test',
				'Console hostname': 'control.example.test',
				'Operations ingest hostname': 'operations.example.test',
			},
			controlEnvironment: { FABRIKA_CONTROL_DOMAIN: 'other.example.test' },
		})
		await expect(runInit({ installation: 'test' }, mismatch.collaborators)).rejects.toThrow('configuration did not complete')
		expect(mismatch.effects.some((effect) => effect.startsWith('create-app:'))).toBe(false)

		const unpublished = recorder({ answers: ANSWERS, appMode: 'create', proxyPublished: false })
		await expect(runInit({ installation: 'test' }, unpublished.collaborators)).rejects.toThrow('configuration did not complete')
		expect(unpublished.effects.some((effect) => effect.startsWith('create-app:'))).toBe(false)
	})

	test('allows explicit anonymous mode without validating an unpublished proxy origin', async () => {
		const recorded = recorder({ answers: ANSWERS, appMode: 'anonymous', proxyPublished: false })
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.effects.some((effect) => effect.startsWith('create-app:'))).toBe(false)
		expect(recorded.effects.some((effect) => effect.startsWith('webhook:'))).toBe(false)
		await cleanCheckout(recorded)
	})

	test('resumes safely after a crash following each individual Zerops credential write', async () => {
		for (const key of ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_ID', 'GITHUB_WEBHOOK_SECRET']) {
			const recorded = recorder({
				appMode: 'create',
				appOwner: 'contember',
				answers: { ...ANSWERS, 'GitHub organization that will own the App': 'contember', 'GitHub App name': 'fabrika-test' },
				confirms: { 'Has the GitHub App been installed with the requested access?': true },
				installedRepositories: ['contember'],
				crashAfterWriteKey: key,
			})
			await expect(runInit({ installation: 'test' }, recorded.collaborators)).rejects.toThrow('configuration did not complete')
			expect(recorded.effects.filter((effect) => effect.startsWith('create-app:'))).toHaveLength(1)
			recorded.resumeReads()
			await runInit({ installation: 'test' }, recorded.collaborators)
			expect(recorded.effects.filter((effect) => effect.startsWith('create-app:'))).toHaveLength(1)
			expect(recorded.sourceEnv.get('GITHUB_APP_PRIVATE_KEY')).toBe(APP_PEM)
			expect(recorded.sourceEnv.get('GITHUB_APP_ID')).toBe('123')
			expect(recorded.controlEnv.get('GITHUB_WEBHOOK_SECRET')).toBe('webhook-secret')
			await cleanCheckout(recorded)
		}
	})

	test('accepts an ambiguous Zerops write only when exact plaintext reads back', async () => {
		const recorded = recorder({
			appMode: 'create',
			appOwner: 'contember',
			answers: { ...ANSWERS, 'GitHub organization that will own the App': 'contember', 'GitHub App name': 'fabrika-test' },
			confirms: { 'Has the GitHub App been installed with the requested access?': true },
			installedRepositories: ['contember'],
			ambiguousWriteKey: 'GITHUB_APP_ID',
		})
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.sourceEnv.get('GITHUB_APP_ID')).toBe('123')
		expect(recorded.lines.join('\n')).not.toContain('upstream response')
		await cleanCheckout(recorded)
	})

	test('polls boundedly until a successful Zerops write becomes visible', async () => {
		const recorded = recorder({
			appMode: 'create',
			appOwner: 'contember',
			answers: { ...ANSWERS, 'GitHub organization that will own the App': 'contember', 'GitHub App name': 'fabrika-test' },
			confirms: { 'Has the GitHub App been installed with the requested access?': true },
			installedRepositories: ['contember'],
			delayedVisibility: { key: 'GITHUB_APP_PRIVATE_KEY', reads: 2 },
		})
		await runInit({ installation: 'test' }, recorded.collaborators)
		expect(recorded.effects.filter((effect) => effect === 'sleep:500')).toHaveLength(4)
		expect(recorded.sourceEnv.get('GITHUB_APP_PRIVATE_KEY')).toBe(APP_PEM)
		await cleanCheckout(recorded)
	})

	test('fails closed when a concurrent writer changes credentials during final stability reads', async () => {
		const recorded = recorder({
			appMode: 'create',
			appOwner: 'contember',
			answers: { ...ANSWERS, 'GitHub organization that will own the App': 'contember', 'GitHub App name': 'fabrika-test' },
			conflictAfterCompleteSourceReads: 2,
		})
		await expect(runInit({ installation: 'test' }, recorded.collaborators)).rejects.toThrow('configuration did not complete')
		expect(recorded.effects.some((effect) => effect.startsWith('webhook:'))).toBe(false)
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
			configureSourceService(
				{ projectId: 'project-id-1', environment: 'test' },
				api,
				async () => {},
				new AbortController().signal,
			),
		).rejects.toThrow('did not retain one matching source RPC key')
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
