// What `--create-project` adds to the bring-up: the project itself.
//
// Three properties are observable nowhere else. The ORDER — create, then wait for `ACTIVE`, and only
// then import — because whether a service import into a project the platform is still CREATING succeeds
// has never been measured, so the command waits rather than finds out. The RESUME line, printed before
// the wait, because an interrupted run has already spent a project on the account and its id is the only
// way back to it. And the two ways of asking for a project twice, which are refused before anything is
// contacted.

import { type ZeropsApi, ZeropsApiError, type ZeropsProjectStatus } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { compileTopology, platformTopology } from '../../zerops/topology'
import { type InstallCollaborators, runInstall } from '../install'
import { CREATE_PROJECT_FLAG, parsePlatformInstallArgs, type PlatformInstallInput } from '../install-options'
import { recordingInitLog } from '../log'
import { type FakeZerops, fakeZerops, importedLightServices } from './fake-zerops'

const PROJECT = { projectId: 'proj-created', projectName: 'fabrika-stage' }
const CLIENT_ID = 'client-1'
const TOKEN_ENV = { FABRIKA_ZEROPS_ACCESS_TOKEN: 'token' }

/** Live (2026-08-21): the import answers in ~1 s, and the project settles through these in about 20 s. */
const SETTLING: readonly ZeropsProjectStatus[] = ['NEW', 'CREATING', 'ACTIVE']

const input = (overrides: Partial<PlatformInstallInput> = {}): PlatformInstallInput => ({
	project: { kind: 'create', projectName: PROJECT.projectName },
	clientId: CLIENT_ID,
	accessToken: 'zerops-personal-access-token-that-must-never-be-printed',
	environment: 'stage',
	scheme: 'https',
	buildFromGit: 'https://github.com/contember/fabrika-platform',
	tier: 'light',
	unattended: false,
	...overrides,
})

interface Harness {
	readonly zerops: FakeZerops
	readonly log: ReturnType<typeof recordingInitLog>
	readonly asked: string[]
	/** Every `sleep(ms)` the run asked for, so the interval and the bound are observable. */
	readonly sleeps: number[]
	run(): Promise<void>
}

/** A `getProject` that fails its first `times` calls, the way a 5xx on the read does. */
const failingReads = (times: number) => (api: ZeropsApi): ZeropsApi => {
	let seen = 0
	return {
		...api,
		getProject: async (call) => {
			seen += 1
			if (seen <= times) {
				throw new ZeropsApiError('zerops: get project failed (503)', 503, '')
			}
			return api.getProject(call)
		},
	}
}

/** An account with the client but NOT the project: `importProject` is the only thing that can create it. */
const harness = (
	options: {
		readonly statuses?: readonly ZeropsProjectStatus[]
		readonly decline?: string
		readonly wrap?: (api: ZeropsApi) => ZeropsApi
	} = {},
): Harness => {
	const zerops = fakeZerops({
		...PROJECT,
		projectMode: 'LIGHT',
		services: [],
		bootstrap: { clientId: CLIENT_ID, imported: importedLightServices() },
		creates: { clientId: CLIENT_ID, statuses: options.statuses ?? SETTLING },
	})
	const log = recordingInitLog()
	const asked: string[] = []
	const sleeps: number[] = []
	const collaborators: InstallCollaborators = {
		api: options.wrap === undefined ? zerops.api : options.wrap(zerops.api),
		reconcileSchema: async () => {},
		sleep: async (ms) => void sleeps.push(ms),
		log,
		prompts: {
			confirm: async (question) => {
				asked.push(question)
				return options.decline === undefined || !question.includes(options.decline)
			},
		},
		signal: new AbortController().signal,
	}
	return { zerops, log, asked, sleeps, run: () => runInstall(input(), collaborators) }
}

describe('the order', () => {
	test('creates the project, polls it to ACTIVE, and only then imports the services', async () => {
		const fixture = harness()

		await fixture.run()

		const projectCalls = fixture.zerops.timeline.filter((entry) =>
			entry.startsWith('project-import:') || entry.startsWith(`project:${PROJECT.projectId}:`)
		)
		expect(projectCalls.slice(0, 4)).toEqual([
			'project-import:client-1',
			`project:${PROJECT.projectId}:NEW`,
			`project:${PROJECT.projectId}:CREATING`,
			`project:${PROJECT.projectId}:ACTIVE`,
		])
		const created = fixture.zerops.timeline.indexOf('project-import:client-1')
		const active = fixture.zerops.timeline.indexOf(`project:${PROJECT.projectId}:ACTIVE`)
		const imported = fixture.zerops.timeline.indexOf(`import:${PROJECT.projectId}`)
		expect(created).toBeGreaterThanOrEqual(0)
		expect(active).toBeGreaterThan(created)
		expect(imported).toBeGreaterThan(active)
	})

	test('exactly one project is created, and the bring-up runs through to the deploy in it', async () => {
		const fixture = harness()

		await fixture.run()

		expect(fixture.zerops.projectImports).toHaveLength(1)
		expect(fixture.zerops.calls.filter((call) => call.startsWith('project-import:'))).toEqual(['project-import:client-1'])
		// The id control is told to deploy into is the CREATED one, not one that arrived on a flag.
		expect(fixture.zerops.env('control').get('FABRIKA_ZEROPS_PROJECT_ID')).toBe(PROJECT.projectId)
		expect(fixture.zerops.calls).toContain('deploy:control')
	})
})

describe('the document it creates the project with', () => {
	test('carries the two settings a project accepts at CREATION only, from the compiled topology', async () => {
		const fixture = harness()

		await fixture.run()

		const declared = compileTopology(platformTopology({ env: 'stage', tier: 'light', publicAccess: 'zerops-subdomain' }), 'stage')
			.provision.document.project
		expect(declared?.envIsolation).toBe('service')
		expect(declared?.corePackage).toBe('LIGHT')

		const yaml = fixture.zerops.projectImports[0] ?? 'no project import'
		expect(yaml).toContain('envIsolation: service')
		expect(yaml).toContain('corePackage: LIGHT')
		// Only the NAME is this run's; everything else comes from the same declaration.
		expect(yaml).toContain(`name: ${PROJECT.projectName}`)
		for (const tag of declared?.tags ?? ['no tags']) {
			expect(yaml).toContain(tag)
		}
		// No services: they arrive through the services-only import, into the project this creates.
		expect(yaml).toEndWith('services: []\n')
	})
})

describe('what it prints', () => {
	test('names the created project id BEFORE the wait, so an interrupted run can be resumed', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			projectMode: 'LIGHT',
			services: [],
			bootstrap: { clientId: CLIENT_ID, imported: importedLightServices() },
			creates: { clientId: CLIENT_ID, statuses: SETTLING },
		})
		const log = recordingInitLog()
		let linesAtFirstPoll = -1
		const api = {
			...zerops.api,
			getProject: async (call: Parameters<typeof zerops.api.getProject>[0]) => {
				if (linesAtFirstPoll < 0) {
					linesAtFirstPoll = log.lines.length
				}
				return zerops.api.getProject(call)
			},
		}

		await runInstall(input(), {
			api,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log,
			prompts: { confirm: async () => true },
			signal: new AbortController().signal,
		})

		const resume = log.lines.findIndex((line) => line.includes(`--project-id=${PROJECT.projectId}`))
		expect(resume).toBeGreaterThanOrEqual(0)
		expect(log.lines[resume]).toContain(`created Zerops project ${PROJECT.projectId} (${PROJECT.projectName})`)
		expect(resume).toBeLessThan(linesAtFirstPoll)
	})

	test('a project that never reaches ACTIVE stops the run, naming the id to resume it with', async () => {
		const fixture = harness({ statuses: ['CREATING'] })

		const failure = await fixture.run().then(() => null, (cause: unknown) => cause)

		expect(String(failure)).toContain('still reads `CREATING` after two minutes (61 reads, 2 s apart)')
		expect(String(failure)).toContain(`--project-id=${PROJECT.projectId}`)
		// The project exists; nothing was imported into it and no token was minted on it.
		expect(fixture.zerops.calls).toEqual(['project-import:client-1'])
		// The bound and the interval the constants promise: 61 reads with 60 two-second sleeps between them.
		expect(fixture.zerops.timeline.filter((entry) => entry.startsWith(`project:${PROJECT.projectId}:`))).toHaveLength(61)
		expect(fixture.sleeps).toHaveLength(60)
		expect([...new Set(fixture.sleeps)]).toEqual([2_000])
	})
})

describe('a project that cannot be installed into', () => {
	test('a state a bring-up cannot recover from fails at once, and never offers a resume', async () => {
		// Waiting these out would only be a slower failure, and `--project-id` into one installs nothing.
		const unusable: readonly ZeropsProjectStatus[] = ['FAILED', 'DELETING', 'STOPPING', 'STOPPED']
		for (const status of unusable) {
			const fixture = harness({ statuses: [status] })

			const failure = await fixture.run().then(() => null, (cause: unknown) => cause)

			expect(String(failure)).toContain(`reads \`${status}\`, which a bring-up cannot recover from`)
			expect(String(failure)).toContain('do NOT resume into this one')
			expect(String(failure)).not.toContain('--project-id=')
			expect(fixture.sleeps).toEqual([])
			expect(fixture.zerops.calls).toEqual(['project-import:client-1'])
		}
	})

	test('a state on the way to ACTIVE is waited on, including one this build does not know', async () => {
		const fixture = harness({ statuses: ['NEW', 'STARTING', 'ACTIVE'] })

		await fixture.run()

		expect(fixture.zerops.calls).toContain('deploy:control')
	})
})

describe('a read that fails while the project settles', () => {
	test('is ridden out, because a failed read says nothing about the project', async () => {
		const fixture = harness({ wrap: failingReads(3) })

		await fixture.run()

		expect(fixture.zerops.calls).toContain('deploy:control')
	})

	test('gives the run back with the id once it will not stop, so the created project is not lost', async () => {
		const fixture = harness({ wrap: failingReads(Number.POSITIVE_INFINITY) })

		const failure = await fixture.run().then(() => null, (cause: unknown) => cause)

		expect(String(failure)).toContain('could not be read 4 times in a row')
		expect(String(failure)).toContain(`--project-id=${PROJECT.projectId}`)
		expect(failure instanceof Error ? failure.cause : undefined).toBeInstanceOf(ZeropsApiError)
		expect(fixture.sleeps).toHaveLength(3)
	})
})

describe('the confirmation', () => {
	test('states that a project will be created, and it is still six questions', async () => {
		const fixture = harness()

		await fixture.run()

		expect(fixture.asked).toHaveLength(6)
		expect(fixture.asked[0]).toContain(`CREATE Zerops project \`${PROJECT.projectName}\``)
		expect(fixture.asked[0]).toContain('core package LIGHT, envIsolation service')
		expect(fixture.asked[0]).toContain(`on client ${CLIENT_ID}`)
	})

	test('declining it creates nothing at all', async () => {
		const fixture = harness({ decline: 'CREATE Zerops project' })

		await expect(fixture.run()).rejects.toThrow('no project was created')
		expect(fixture.zerops.calls).toEqual([])
		expect(fixture.zerops.projectImports).toEqual([])
	})
})

describe('the argument surface', () => {
	test('refuses a project id beside it, naming where that id came from', () => {
		expect(() => parsePlatformInstallArgs([CREATE_PROJECT_FLAG, '--project-id=p1', '--client-id=c1', '--env=stage'], TOKEN_ENV)).toThrow(
			'--create-project creates the project and --project-id names one that already exists',
		)
		// The case the command line does not show: an id inherited from the shell.
		expect(() => parsePlatformInstallArgs([CREATE_PROJECT_FLAG, '--client-id=c1', '--env=stage'], { ...TOKEN_ENV, FABRIKA_ZEROPS_PROJECT_ID: 'p1' }))
			.toThrow('--create-project creates the project and FABRIKA_ZEROPS_PROJECT_ID names one that already exists')
	})

	test('refuses `--project-name` on its own, because there is nothing to name', () => {
		expect(() => parsePlatformInstallArgs(['--project-name=x', '--project-id=p1', '--client-id=c1', '--env=stage'], TOKEN_ENV)).toThrow(
			'--project-name names a project to CREATE',
		)
	})

	test('names the project after the installation unless the operator names it', () => {
		expect(parsePlatformInstallArgs([CREATE_PROJECT_FLAG, '--client-id=c1', '--env=stage'], TOKEN_ENV).project).toEqual({
			kind: 'create',
			projectName: 'fabrika-stage',
		})
		expect(parsePlatformInstallArgs([CREATE_PROJECT_FLAG, '--project-name=chosen', '--client-id=c1', '--env=stage'], TOKEN_ENV).project)
			.toEqual({ kind: 'create', projectName: 'chosen' })
	})

	test('carries no value, like the other boolean flag', () => {
		expect(() => parsePlatformInstallArgs([`${CREATE_PROJECT_FLAG}=true`, '--client-id=c1', '--env=stage'], TOKEN_ENV)).toThrow(
			'unexpected argument',
		)
	})
})
