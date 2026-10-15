import type { EnvironmentConfig, SidecarScaffoldInput, SidecarScaffoldResult } from '@fabrika/installation-init'
import { confirmations } from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type InitCollaborators, inspectPlatform, runInit, sourceConnectionSettingsUrl } from '../init'
import { checkedEnvironmentName, type InitInput, parseInitArgs } from '../init-options'
import { recordingInitLog } from '../log'
import { MACHINE_KEY_NEXT_STEP_TITLE } from '../machine-key'
import { fakeZerops, platformServices } from './fake-zerops'

const ACCESS_TOKEN = 'zerops-access-token-value-that-must-never-be-printed'
const PROVISIONING_KEY = 'px_provisioning-key-value-that-must-never-be-printed'
/** What the LIVE control service holds, so the closing block is asserted against a real-looking env. */
const LIVE_RPC_KEY = 'rpc_live-value-that-must-never-be-printed'
const LIVE_PROVISIONING_KEY = 'px_live-value-that-must-never-be-printed'

const CREDENTIALS = { FABRIKA_ZEROPS_ACCESS_TOKEN: ACCESS_TOKEN, FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY }
const ARGV = ['test', '--tag=v0.1.0', '--project-id=project-id-1']
/** Outside any repository, so the default sidecar checkout is accepted. */
const CWD = realpathSync(mkdtempSync(join(tmpdir(), 'zerops-init-')))
const CUSTOM_HOSTS = ['--iam-host=iam.example.com', '--console-host=console.example.com', '--operations-host=errors.example.com']

interface Recorder {
	readonly input: InitInput
	readonly run: () => Promise<void>
	readonly collaborators: InitCollaborators
	readonly asked: string[]
	readonly effects: string[]
	readonly lines: readonly string[]
	readonly environments: EnvironmentConfig[]
	readonly scaffolds: SidecarScaffoldInput[]
	readonly inspectInputs: Parameters<InitCollaborators['effects']['inspectPlatform']>[0][]
}

const recorder = (options: {
	readonly confirms?: Record<string, boolean>
	readonly repositoryExists?: boolean
	readonly custom?: boolean
	readonly controlEnvironment?: Readonly<Record<string, string>>
	readonly proxyPublished?: boolean
	/** The `fabrika.ref` an existing sidecar checkout already holds. */
	readonly existingPin?: string
}): Recorder => {
	const input = parseInitArgs([...ARGV, ...(options.custom === true ? CUSTOM_HOSTS : [])], CREDENTIALS, CWD)
	const asked: string[] = []
	const effects: string[] = []
	const environments: EnvironmentConfig[] = []
	const scaffolds: SidecarScaffoldInput[] = []
	const inspectInputs: Parameters<InitCollaborators['effects']['inspectPlatform']>[0][] = []
	const derivedControlHost = 'proxy-292c-8082.prg1.zerops.app'
	const derivedIamHost = 'proxy-292c-8080.prg1.zerops.app'
	const controlEnv = new Map([
		['FABRIKA_CONTROL_DOMAIN', input.hosts?.control ?? derivedControlHost],
		['FABRIKA_IAM_ISSUER', `https://${input.hosts?.iam ?? derivedIamHost}`],
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
	const collaborators: InitCollaborators = {
		log,
		prompts: {
			confirm: async (question, defaultYes) => {
				asked.push(`confirm: ${question}`)
				return options.confirms?.[question] ?? defaultYes ?? false
			},
		},
		effects: {
			repositoryExists: async (repo) => {
				effects.push(`exists: ${repo}`)
				return options.repositoryExists ?? false
			},
			scaffold: async (scaffoldInput): Promise<SidecarScaffoldResult> => {
				effects.push(`scaffold: ${scaffoldInput.repo}`)
				scaffolds.push(scaffoldInput)
				if (options.existingPin !== undefined) await Bun.write(join(scaffoldInput.dir, 'fabrika.ref'), `${options.existingPin}\n`)
				await scaffoldInput.materialize(scaffoldInput.dir)
				return { dir: scaffoldInput.dir, created: options.existingPin === undefined }
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
			inspectPlatform: async (inspectInput) => {
				inspectInputs.push(inspectInput)
				effects.push(`inspect: ${inspectInput.projectId}`)
				return { controlEnv, proxyEnv, proxyPublished: options.proxyPublished ?? true }
			},
		},
	}
	return {
		input,
		run: () => runInit(input, collaborators),
		collaborators,
		asked,
		effects,
		environments,
		scaffolds,
		inspectInputs,
		lines: log.lines,
	}
}

const cleanCheckout = async (recorded: Recorder): Promise<void> => {
	for (const scaffold of recorded.scaffolds) await rm(scaffold.dir, { recursive: true, force: true })
}

describe('fabrika platform init --provider=zerops', () => {
	test('writes nothing to Zerops and confirms only its five outward steps', async () => {
		const recorded = recorder({})
		await recorded.run()
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
		const recorded = recorder({})
		await recorded.run()
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
		const matching = recorder({ custom: true })
		await matching.run()
		expect(matching.lines.join('\n')).toContain('https://console.example.com/settings/source')
		expect(matching.environments[0]?.vars).toMatchObject({ FABRIKA_PLATFORM_CONSOLE_HOST: 'console.example.com' })
		await cleanCheckout(matching)

		const mismatch = recorder({ custom: true, controlEnvironment: { FABRIKA_CONTROL_DOMAIN: 'other.example.com' } })
		await mismatch.run()
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
		const inspectFailure = recorder({})
		const inspectCollaborators: InitCollaborators = {
			...inspectFailure.collaborators,
			effects: { ...inspectFailure.collaborators.effects, inspectPlatform: () => Promise.reject(new Error(`private ${LIVE_RPC_KEY}`)) },
		}
		const inspectError = await runInit(inspectFailure.input, inspectCollaborators).catch((error: unknown) => error)
		expect(inspectError instanceof Error ? inspectError.message : '').toBe(
			'the `control` and `proxy` services could not be read; no credential value is shown. Inspect them in Zerops, then run init again',
		)

		const declined = recorder({
			confirms: { 'Read `control` and `proxy` in Zerops project project-id-1 for the console and IAM origins?': false },
		})
		await declined.run()
		expect(declined.effects[0]).toBe('describe: project-id-1')
		expect(declined.effects).not.toContain('inspect: project-id-1')
		expect(declined.lines.join('\n')).toContain('No unverified URL was guessed')
		expect(declined.lines.join('\n')).not.toContain('export FABRIKA_IAM_RPC_URL=')
		await cleanCheckout(declined)

		const projectFailure = recorder({})
		const projectCollaborators: InitCollaborators = {
			...projectFailure.collaborators,
			effects: {
				...projectFailure.collaborators.effects,
				describeProject: () => Promise.reject(new Error(`private ${ACCESS_TOKEN}`)),
			},
		}
		const projectError = await runInit(projectFailure.input, projectCollaborators).catch((error: unknown) => error)
		expect(projectError instanceof Error ? projectError.message : '').toContain('Nothing has been created')
		expect(projectError instanceof Error ? projectError.message : '').not.toContain(ACCESS_TOKEN)
	})

	test('stops later outward effects when repository or Environment confirmation is declined', async () => {
		const repository = recorder({
			confirms: { 'Create contember/fabrika-zerops-test (private) on GitHub and push the pipeline?': false },
		})
		await repository.run()
		expect(repository.effects).toEqual(['describe: project-id-1', 'inspect: project-id-1', 'exists: contember/fabrika-zerops-test'])
		expect(repository.lines.join('\n')).toContain(
			`fabrika platform init --provider=zerops test --repo=contember/fabrika-zerops-test --checkout=${
				join(CWD, 'fabrika-zerops-test')
			} --tag=v0.1.0 --project-id=project-id-1 --env=test`,
		)

		const environment = recorder({
			confirms: { 'Write them to the test Environment now (secret VALUES go to GitHub over `gh` stdin)?': false },
		})
		await environment.run()
		expect(environment.effects).not.toContain('environment: test')
		expect(environment.effects.some((effect) => effect.startsWith('trigger:'))).toBe(false)
		await cleanCheckout(environment)
	})

	test('refuses to trigger a run when an existing sidecar keeps a pin other than --tag, and names both ways on', async () => {
		const recorded = recorder({ repositoryExists: true, existingPin: 'v0.0.9' })
		const error = await recorded.run().catch((caught: unknown) => caught)

		expect(recorded.effects).toContain('environment: test')
		expect(recorded.effects.some((effect) => effect.startsWith('trigger:'))).toBe(false)
		expect(recorded.asked).not.toContain('confirm: Run the platform workflow on contember/fabrika-zerops-test now?')
		const message = error instanceof Error ? error.message : ''
		expect(message).toContain('the platform workflow was NOT triggered: contember/fabrika-zerops-test pins v0.0.9, not v0.1.0')
		expect(message).toContain(
			`fabrika platform upgrade --provider=zerops --to=v0.1.0 --sidecar=${join(CWD, 'fabrika-zerops-test')}`,
		)
		expect(message).toContain('run init again with --tag=v0.0.9')
		expect(await Bun.file(join(CWD, 'fabrika-zerops-test', 'fabrika.ref')).text()).toBe('v0.0.9\n')
		await cleanCheckout(recorded)
	})

	test('triggers the run when an existing sidecar already pins --tag', async () => {
		const recorded = recorder({ repositoryExists: true, existingPin: 'v0.1.0' })
		await recorded.run()

		expect(recorded.effects).toContain('trigger: contember/fabrika-zerops-test')
		await cleanCheckout(recorded)
	})

	test('ends with the block `control key issue` needs, built from the live IAM origin and two NAMES', async () => {
		const recorded = recorder({})
		await recorded.run()

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
		const older = recorder({ controlEnvironment: { FABRIKA_IAM_ISSUER: '' } })
		await older.run()
		expect(older.lines.join('\n')).not.toContain('export FABRIKA_IAM_RPC_URL=')
		expect(older.lines.join('\n')).toContain("read from: `control`'s own FABRIKA_IAM_ISSUER")
		await cleanCheckout(older)

		const mismatch = recorder({ custom: true, controlEnvironment: { FABRIKA_IAM_ISSUER: 'https://iam.other.example.com' } })
		await mismatch.run()
		expect(mismatch.lines.join('\n')).not.toContain('https://iam.other.example.com')
		expect(mismatch.lines.join('\n')).not.toContain('export FABRIKA_IAM_RPC_URL=')
		await cleanCheckout(mismatch)

		const custom = recorder({ custom: true })
		await custom.run()
		expect(custom.lines.join('\n')).toContain('export FABRIKA_IAM_RPC_URL=https://iam.example.com')
		await cleanCheckout(custom)
	})

	test('the confirmations need a terminal or --yes, and --yes still prints every question', async () => {
		expect(() => confirmations(false, { isTTY: false }, () => {}, 'writes a sidecar')).toThrow('pass `--yes`')
		const announced: string[] = []
		const unattended = confirmations(true, { isTTY: false }, (line) => announced.push(line), 'writes a sidecar')
		expect(await unattended.confirm('Create acme/sidecar?')).toBe(true)
		expect(announced).toEqual(['Create acme/sidecar? yes (--yes)'])
	})
})

describe('parseInitArgs', () => {
	test('reads every value from a flag or the environment, flag first, and nothing from a prompt', () => {
		expect(parseInitArgs([...ARGV, '--repo=acme/sidecar', '--yes'], CREDENTIALS, CWD)).toEqual({
			installation: 'test',
			repo: 'acme/sidecar',
			checkoutDir: join(CWD, 'fabrika-zerops-test'),
			fabrikaRef: 'v0.1.0',
			projectId: 'project-id-1',
			environmentName: 'test',
			accessToken: ACCESS_TOKEN,
			provisioningKey: PROVISIONING_KEY,
			unattended: true,
		})
		const fromEnv = parseInitArgs(['test'], {
			...CREDENTIALS,
			FABRIKA_PLATFORM_TAG: 'v0.2.0',
			FABRIKA_ZEROPS_PROJECT_ID: 'project-id-2',
			FABRIKA_PLATFORM_ENVIRONMENT: 'prod',
			FABRIKA_ZEROPS_API_URL: 'https://api.example.com',
		}, CWD)
		expect(fromEnv).toMatchObject({ repo: 'contember/fabrika-zerops-test', fabrikaRef: 'v0.2.0', projectId: 'project-id-2', environmentName: 'prod' })
		expect(fromEnv.apiBaseUrl).toBe('https://api.example.com')
		expect(
			parseInitArgs([...ARGV, '--tag=v0.3.0'].filter((arg) => arg !== '--tag=v0.1.0'), { ...CREDENTIALS, FABRIKA_PLATFORM_TAG: 'v0.1.0' }, CWD)
				.fabrikaRef,
		)
			.toBe('v0.3.0')
		expect(parseInitArgs([...ARGV, ...CUSTOM_HOSTS], CREDENTIALS, CWD).hosts).toEqual({
			iam: 'iam.example.com',
			control: 'console.example.com',
			operations: 'errors.example.com',
		})
	})

	test('refuses what is missing, malformed or a credential on the command line, naming the flag and the variable', () => {
		expect(() => parseInitArgs(['test', '--project-id=p'], CREDENTIALS, CWD)).toThrow('--tag=<value> or FABRIKA_PLATFORM_TAG is required')
		expect(() => parseInitArgs(['test', '--tag=v0.1.0'], CREDENTIALS, CWD)).toThrow('--project-id=<value> or FABRIKA_ZEROPS_PROJECT_ID is required')
		expect(() => parseInitArgs(['test', '--tag=main', '--project-id=p'], CREDENTIALS, CWD)).toThrow('is not a published tag')
		expect(() => parseInitArgs(ARGV, { FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY }, CWD)).toThrow('FABRIKA_ZEROPS_ACCESS_TOKEN is required')
		expect(() => parseInitArgs(ARGV, { FABRIKA_ZEROPS_ACCESS_TOKEN: ACCESS_TOKEN }, CWD)).toThrow('FABRIKA_IAM_PROVISIONING_KEY is required')
		expect(() => parseInitArgs([...ARGV, '--env=local'], CREDENTIALS, CWD)).toThrow('is refused')
		expect(() => checkedEnvironmentName('local')).toThrow('is refused')
		expect(() => parseInitArgs([...ARGV, '--iam-host=iam.example.com'], CREDENTIALS, CWD)).toThrow('name every platform host or none')
		expect(() => parseInitArgs([...ARGV, '--token=secret'], CREDENTIALS, CWD)).toThrow('unexpected argument')
		expect(() => parseInitArgs([...ARGV, 'second'], CREDENTIALS, CWD)).toThrow('name ONE installation')
		expect(() => parseInitArgs([...ARGV, '--repo=nope'], CREDENTIALS, CWD)).toThrow('is not a <owner>/<name> repository')
		expect(() => parseInitArgs(['--tag=v0.1.0'], CREDENTIALS, CWD)).toThrow('requires an installation name')
		const repository = join(CWD, 'operator-repository')
		mkdirSync(join(repository, '.git'), { recursive: true })
		expect(() => parseInitArgs(ARGV, CREDENTIALS, repository)).toThrow('--checkout=<dir> outside it')
		expect(parseInitArgs([...ARGV, `--checkout=${join(CWD, 'sidecar')}`], CREDENTIALS, repository).checkoutDir).toBe(join(CWD, 'sidecar'))
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
