import type { EnvironmentConfig, SidecarScaffoldInput, SidecarScaffoldResult } from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { checkedEnvironmentName, type InitCollaborators, parseInitArgs, runInit } from '../init'
import { recordingInitLog } from '../log'

const ACCESS_TOKEN = 'zerops-access-token-value-that-must-never-be-printed'
const PROVISIONING_KEY = 'px_provisioning-key-value-that-must-never-be-printed'

interface Recorder {
	readonly collaborators: InitCollaborators
	readonly asked: string[]
	readonly effects: string[]
	readonly lines: readonly string[]
	readonly environments: EnvironmentConfig[]
	readonly scaffolds: SidecarScaffoldInput[]
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
	const log = recordingInitLog()
	return {
		asked,
		effects,
		environments,
		scaffolds,
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
					const chosen = choices[options.custom === true ? 1 : 0]
					if (chosen === undefined) {
						throw new Error('no option')
					}
					return chosen.value
				},
				secret: async (variable) => {
					asked.push(`secret: ${variable}`)
					return variable === 'FABRIKA_ZEROPS_ACCESS_TOKEN' ? ACCESS_TOKEN : PROVISIONING_KEY
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
			'exists: contember/fabrika-zerops-test',
			'scaffold: contember/fabrika-zerops-test',
			'environment: test',
			'trigger: contember/fabrika-zerops-test',
		])
		const confirmations = recorded.asked.filter((entry) => entry.startsWith('confirm: '))
		expect(confirmations).toHaveLength(4)
		expect(confirmations[0]).toContain('Read Zerops project project-id-1')
		expect(confirmations[1]).toContain('Create contember/fabrika-zerops-test (private) on GitHub')
		expect(confirmations[2]).toContain('Write them to the test Environment now')
		expect(confirmations[3]).toContain('Run the platform workflow')
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

	test('declining the repository stops there and says what to run', async () => {
		const recorded = recorder({
			answers: ANSWERS,
			confirms: { 'Create contember/fabrika-zerops-test (private) on GitHub and push the pipeline?': false },
		})

		await runInit({ installation: 'test' }, recorded.collaborators)

		expect(recorded.effects).toEqual(['describe: project-id-1', 'exists: contember/fabrika-zerops-test'])
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
