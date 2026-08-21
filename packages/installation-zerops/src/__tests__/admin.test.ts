import type { GrantDto, PrincipalDetail, PrincipalListItem } from '@fabrika/iam-contract'
import type { FirstAdministratorApi } from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import { type PlatformAdminCollaborators, runPlatformAdmin } from '../admin'
import type { PlatformAdminInput } from '../admin-options'
import { recordingInitLog } from '../log'
import { MACHINE_KEY_NEXT_STEP_TITLE } from '../machine-key'

const ENROLLMENT_URL = 'https://iam.example.test/auth/password/enroll?token=one-time'

const input = (over: Partial<PlatformAdminInput> = {}): PlatformAdminInput => ({
	email: 'operator@example.test',
	iamHost: 'iam.example.test',
	scheme: 'https',
	provisioningKey: 'px_provisioning',
	reissue: false,
	...over,
})

const listItem = (id: string, email: string): PrincipalListItem => ({
	id,
	type: 'user',
	label: email,
	email,
	externalId: null,
	status: 'invited',
	createdAt: 1,
})

const crossAppAdminGrant = (principalId: string): GrantDto => ({
	id: `grant-${principalId}`,
	principalId,
	roleKey: 'admin',
	permissions: null,
	scopeType: null,
	scopeValue: null,
	app: null,
	grantedBy: null,
	expiresAt: null,
	createdAt: 1,
	dangling: false,
})

interface FakeOptions {
	readonly existing?: PrincipalListItem
	readonly grants?: GrantDto[]
	readonly password?: 'unavailable' | 'disabled' | 'pending' | 'enabled'
	readonly failOn?: keyof typeof PROCEDURES
}

const PROCEDURES = {
	list: 'principals.list',
	invite: 'principals.invite',
	get: 'principals.get',
	create: 'grants.create',
	enroll: 'passwords.issueEnrollment',
}

/** The five procedures this flow calls, in memory. Anything not configured answers the fresh-install path. */
const fakeApi = (options: FakeOptions = {}): { api: FirstAdministratorApi; calls: string[] } => {
	const calls: string[] = []
	const created = options.existing ?? listItem('principal-1', 'operator@example.test')
	const refuse = (name: keyof typeof PROCEDURES): void => {
		if (options.failOn === name) {
			throw new Error(`${PROCEDURES[name]} failed: unauthorized (HTTP 401)`)
		}
	}
	return {
		calls,
		api: {
			principals: {
				list: async () => {
					calls.push('principals.list')
					refuse('list')
					return { items: options.existing === undefined ? [] : [options.existing], nextCursor: null }
				},
				invite: async () => {
					calls.push('principals.invite')
					refuse('invite')
					return created
				},
				get: async (): Promise<PrincipalDetail> => {
					calls.push('principals.get')
					refuse('get')
					return {
						...created,
						grants: options.grants ?? [],
						permissions: [],
						authentication: { oidc: { state: 'unavailable' }, password: { state: options.password ?? 'disabled' } },
					}
				},
			},
			grants: {
				create: async () => {
					calls.push('grants.create')
					refuse('create')
					return crossAppAdminGrant(created.id)
				},
			},
			passwords: {
				issueEnrollment: async () => {
					calls.push('passwords.issueEnrollment')
					refuse('enroll')
					return { delivery: 'manual', url: ENROLLMENT_URL, expiresAt: 1_700_000_000 }
				},
			},
		},
	}
}

const collaborators = (
	api: FirstAdministratorApi,
): PlatformAdminCollaborators & { readonly lines: readonly string[]; readonly printed: string[] } => {
	const log = recordingInitLog()
	const printed: string[] = []
	return { client: api, log, print: (line) => void printed.push(line), lines: log.lines, printed }
}

describe('platform admin', () => {
	test('prints the enrollment URL exactly once, and only to stdout', async () => {
		const { api } = fakeApi()
		const run = collaborators(api)

		await runPlatformAdmin(input(), run)

		expect(run.printed).toEqual([ENROLLMENT_URL])
		expect(run.lines.join('\n')).not.toContain(ENROLLMENT_URL)
		expect(run.lines.join('\n')).toContain('https://iam.example.test · operator@example.test')
	})

	test('reports the invite and the cross-app grant it made', async () => {
		const { api, calls } = fakeApi()
		const run = collaborators(api)

		await runPlatformAdmin(input(), run)

		expect(run.lines).toContain('ok: invited operator@example.test as principal principal-1')
		expect(run.lines).toContain('ok: granted the cross-app `admin` role')
		expect(calls).toEqual(['principals.list', 'principals.invite', 'principals.get', 'grants.create', 'passwords.issueEnrollment'])
	})

	test('a re-run prints no URL, invites nobody and grants nothing', async () => {
		const existing = listItem('principal-1', 'operator@example.test')
		const { api, calls } = fakeApi({ existing, grants: [crossAppAdminGrant('principal-1')], password: 'pending' })
		const run = collaborators(api)

		await runPlatformAdmin(input(), run)

		expect(run.printed).toEqual([])
		expect(calls).toEqual(['principals.list', 'principals.get'])
		expect(run.lines).toContain('ok: operator@example.test already exists as principal principal-1')
		expect(run.lines).toContain('ok: the cross-app `admin` role was already granted')
		expect(run.lines.join('\n')).toContain('an enrollment is already outstanding')
	})

	test('`--reissue` replaces an outstanding enrollment and prints the new URL once', async () => {
		const existing = listItem('principal-1', 'operator@example.test')
		const { api } = fakeApi({ existing, grants: [crossAppAdminGrant('principal-1')], password: 'pending' })
		const run = collaborators(api)

		await runPlatformAdmin(input({ reissue: true }), run)

		expect(run.printed).toEqual([ENROLLMENT_URL])
	})

	test('a password that is already set is reported and nothing is issued', async () => {
		const existing = listItem('principal-1', 'operator@example.test')
		const { api, calls } = fakeApi({ existing, grants: [crossAppAdminGrant('principal-1')], password: 'enabled' })
		const run = collaborators(api)

		await runPlatformAdmin(input(), run)

		expect(run.printed).toEqual([])
		expect(calls).not.toContain('passwords.issueEnrollment')
		expect(run.lines.join('\n')).toContain('a password is already set')
	})

	test('a refused key fails closed and prints no URL', async () => {
		const { api } = fakeApi({ failOn: 'list' })
		const run = collaborators(api)

		await expect(runPlatformAdmin(input(), run)).rejects.toThrow('principals.list failed: unauthorized (HTTP 401)')
		expect(run.printed).toEqual([])
	})

	test('the provisioning key reaches neither the transcript nor stdout', async () => {
		const { api } = fakeApi()
		const run = collaborators(api)

		await runPlatformAdmin(input(), run)

		expect([...run.lines, ...run.printed].join('\n')).not.toContain('px_provisioning')
	})

	test('no failure message quotes the provisioning key either', async () => {
		for (const failOn of ['list', 'invite', 'get', 'create', 'enroll'] as const) {
			const { api } = fakeApi({ failOn })
			const run = collaborators(api)
			const failure = await runPlatformAdmin(input(), run).then(
				() => new Error('the run was expected to fail'),
				(cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
			)
			expect(failure.message).not.toContain('px_provisioning')
			expect([...run.lines, ...run.printed].join('\n')).not.toContain('px_provisioning')
		}
	})

	test('warns once when a non-loopback host is spoken to over plain http, and not otherwise', async () => {
		const plain = collaborators(fakeApi().api)
		await runPlatformAdmin(input({ scheme: 'http' }), plain)
		expect(plain.lines.join('\n')).toContain('plain http to a host that is not loopback')

		const local = collaborators(fakeApi().api)
		await runPlatformAdmin(input({ scheme: 'http', iamHost: 'iam.fabrika.localhost' }), local)
		expect(local.lines.join('\n')).not.toContain('plain http')

		const secure = collaborators(fakeApi().api)
		await runPlatformAdmin(input(), secure)
		expect(secure.lines.join('\n')).not.toContain('plain http')
	})

	test('ends with the block `control key issue` needs: this IAM origin and two variable NAMES', async () => {
		const { api } = fakeApi()
		const run = collaborators(api)

		await runPlatformAdmin(input(), run)

		const block = run.lines.filter((line) => line.startsWith('action: ')).join('\n')
		expect(block).toContain(MACHINE_KEY_NEXT_STEP_TITLE)
		expect(block).toContain('export FABRIKA_IAM_RPC_URL=https://iam.example.test')
		expect(block).toContain('FABRIKA_IAM_RPC_KEY')
		expect(block).toContain('FABRIKA_IAM_PROVISIONING_KEY')
		expect(block).toContain('fabrika control key issue')
		// The command is holding the provisioning key while it prints this; the whole run is names only.
		for (const prefix of ['px_', 'rpc_', 'sk_']) {
			expect([...run.lines, ...run.printed].join('\n')).not.toContain(prefix)
		}
	})

	test('the closing block prints no origin the command was not given', async () => {
		const { api } = fakeApi()
		const run = collaborators(api)

		await runPlatformAdmin(input({ iamHost: 'iam.other.test' }), run)

		expect(run.lines.join('\n')).toContain('export FABRIKA_IAM_RPC_URL=https://iam.other.test')
		expect(run.lines.join('\n')).not.toContain('https://iam.example.test')
	})

	test('a failure at the last step still prints no URL', async () => {
		const { api } = fakeApi({ failOn: 'enroll' })
		const run = collaborators(api)

		await expect(runPlatformAdmin(input(), run)).rejects.toThrow('passwords.issueEnrollment failed')
		expect(run.printed).toEqual([])
	})
})
