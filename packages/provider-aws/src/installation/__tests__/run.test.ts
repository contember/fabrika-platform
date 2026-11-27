// The commands' run: credentials of another account refused first; an install refused where an installation exists
// (naming the upgrade that finishes one) and an upgrade where none does; the installation's choices recorded by an
// install and taken by an upgrade, a changed range, host or environment refused and a changed certificate named;
// nothing written when the operator declines; the bring-up's values reaching the parameters on an install alone; the
// operator's credentials from the environment; and the module the CLI loads.

import type { Confirmations } from '@fabrika/installation-init'
import { isInstallationCli } from '@fabrika/provider-contract/installation'
import { describe, expect, test } from 'bun:test'
import type { StackStatus } from '../../aws/cloudformation'
import type { SsmPlatformSecrets } from '../../aws/ssm'
import type { AwsPlatformApplied, AwsPlatformApplyInput } from '../apply'
import { installationCli, readAwsInstallationGuide } from '../index'
import { parseAwsInstallArgs, parseAwsUpgradeArgs } from '../options'
import { awsPlatformManifest } from '../platform-manifest'
import { AWS_INSTALLATION_RECORD, encodeAwsInstallationRecord, parseAwsInstallationRecord } from '../record'
import { type AwsPlatformClients, environmentCredentials, runAwsPlatform } from '../run'
import { platformState } from './platform-fixture'

const certificate = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const COMMIT = 'a'.repeat(40)
const BASE_IMAGE = `docker.io/oven/bun@sha256:${'b'.repeat(64)}`
const WHERE = ['--account-id=123456789012', '--region=eu-central-1', `--commit=${COMMIT}`, `--base-image=${BASE_IMAGE}`]
const INSTALL = [
	...WHERE,
	'--environment=production',
	'--iam-host=iam.example.com',
	'--control-host=control.example.com',
	'--operations-host=operations.example.com',
	`--iam-certificate=${certificate(1)}`,
	`--control-certificate=${certificate(2)}`,
	`--operations-certificate=${certificate(3)}`,
	'--apps-host=apps.example.com',
	`--apps-certificate=${certificate(4)}`,
]
/** The record an install with `INSTALL` writes. */
const RECORD = encodeAwsInstallationRecord(parseAwsInstallArgs(INSTALL, {}).choices)

/** One account: its Parameter Store in memory, its services' stack's status if it has one, its credentials' account. */
interface FakeAccount {
	readonly store: Map<string, string>
	services: StackStatus | null
	callerAccount: string
	readonly calls: string[]
}

function fakeAccount(): FakeAccount {
	const store = new Map<string, string>()
	for (const service of ['iam', 'control', 'operations']) {
		store.set(`/fabrika/platform/database/${service}-password`, `${service.padEnd(8, 'x')}${'P'.repeat(32)}`)
	}
	return { store, services: null, callerAccount: '123456789012', calls: [] }
}

function clientsOf(account: FakeAccount): AwsPlatformClients {
	const unexpected = async (): Promise<never> => {
		throw new Error('unexpected call')
	}
	const secrets: SsmPlatformSecrets = {
		putSecretOnce: async (name, value) => {
			if (account.store.has(name)) return false
			account.store.set(name, value)
			return true
		},
		putSecret: async (name, value) => {
			account.calls.push(`put ${name}`)
			account.store.set(name, value)
		},
		readSecret: async (name) => account.store.get(name) ?? null,
		listNames: async (path) => [...account.store.keys()].filter((name) => name.startsWith(`${path}/`)).sort(),
	}
	return {
		sts: {
			callerAccount: async () => {
				account.calls.push('sts')
				return account.callerAccount
			},
		},
		cloudFormation: {
			findStack: async (name) => {
				account.calls.push(`find ${name}`)
				return account.services !== null && name === 'fabrika-platform-services' ? { stackId: 'x', status: account.services } : null
			},
			describeStack: unexpected,
			getTemplate: unexpected,
			createStack: unexpected,
			updateStack: unexpected,
		},
		tasks: { runTask: unexpected, describeTask: unexpected, listRunningTasks: unexpected, describeService: unexpected, redeployService: unexpected },
		secrets,
		codeBuild: { startBuild: unexpected, findBuildsWith: unexpected, getBuild: unexpected },
		ecr: { findImage: unexpected },
		manifestWriter: () => ({ complete: unexpected }),
	}
}

const yes: Confirmations = { confirm: async () => true }

function run(kind: 'install' | 'upgrade', argv: readonly string[], account: FakeAccount, confirmations: Confirmations = yes) {
	const applied: AwsPlatformApplyInput[] = []
	const lines: string[] = []
	const shared = {
		clients: clientsOf(account),
		confirmations,
		signal: new AbortController().signal,
		sleep: async () => {},
		log: (line: string) => lines.push(line),
		apply: async (input: AwsPlatformApplyInput): Promise<AwsPlatformApplied> => {
			applied.push(input)
			return { ...platformState(), images: { services: `sha256:${'1'.repeat(64)}`, proxy: `sha256:${'2'.repeat(64)}` } }
		},
	}
	const result = kind === 'install'
		? runAwsPlatform({ kind, options: parseAwsInstallArgs(argv, {}), ...shared })
		: runAwsPlatform({ kind, options: parseAwsUpgradeArgs(argv, {}), ...shared })
	return { result, applied, lines }
}

describe("the AWS installation's commands", () => {
	test('credentials of another account are refused before anything is read in it', async () => {
		const account = fakeAccount()
		account.callerAccount = '210987654321'
		const install = run('install', INSTALL, account)
		await expect(install.result).rejects.toThrow("the credentials in the environment are account 210987654321's, not account 123456789012's")
		expect(account.calls).toEqual(['sts'])
		expect(install.applied).toEqual([])
	})

	test('an install where an installation exists, even one still being created, names the upgrade that finishes it', async () => {
		for (const status of ['CREATE_COMPLETE', 'CREATE_IN_PROGRESS'] satisfies StackStatus[]) {
			const account = fakeAccount()
			account.services = status
			const install = run('install', INSTALL, account)
			await expect(install.result).rejects.toThrow(
				'`platform upgrade` moves it to a release, and finishes an install that stopped once its services were created',
			)
			expect(install.applied).toEqual([])
		}
		const upgrade = run('upgrade', WHERE, fakeAccount())
		await expect(upgrade.result).rejects.toThrow('holds no installation yet; `platform install` makes one')
		expect(upgrade.applied).toEqual([])
	})

	test('an install records its choices before its first stack; a resumed one must make the same ones', async () => {
		const account = fakeAccount()
		await run('install', INSTALL, account).result
		expect(account.store.get(AWS_INSTALLATION_RECORD)).toBe(RECORD)
		// Resumed with the platform network moved: refused, naming the change, before anything is applied.
		const moved = run('install', [...INSTALL, '--platform-vpc-cidr=10.90.0.0/16'], account)
		await expect(moved.result).rejects.toThrow('the platform network range from 10.81.0.0/16 to 10.90.0.0/16')
		expect(moved.applied).toEqual([])
		// Resumed with a renewed certificate: named, and the record follows.
		const renewed = run(
			'install',
			[...INSTALL.filter((arg) => !arg.startsWith('--control-certificate')), `--control-certificate=${certificate(9)}`],
			account,
		)
		await renewed.result
		expect(renewed.lines).toContain(`aws: changing Control's certificate from ${certificate(2)} to ${certificate(9)}`)
		expect(parseAwsInstallationRecord(account.store.get(AWS_INSTALLATION_RECORD) ?? '').plan.certificates.control).toBe(certificate(9))
	})

	test('an upgrade takes every choice it does not name from the record, and refuses a changed range, host or environment', async () => {
		const account = fakeAccount()
		account.services = 'CREATE_COMPLETE'
		const missing = run('upgrade', WHERE, account)
		await expect(missing.result).rejects.toThrow(`has no record at ${AWS_INSTALLATION_RECORD}`)
		account.store.set(AWS_INSTALLATION_RECORD, RECORD)
		const upgrade = run('upgrade', WHERE, account)
		await upgrade.result
		const [input] = upgrade.applied
		expect(input?.plan).toEqual(parseAwsInstallationRecord(RECORD).plan)
		// An unchanged record is not written again.
		expect(account.calls.filter((call) => call === `put ${AWS_INSTALLATION_RECORD}`)).toEqual([])
		for (
			const [flag, change] of [
				['--apps-vpc-cidr=10.70.0.0/16', 'the applications network range from 10.80.0.0/16 to 10.70.0.0/16'],
				['--control-host=console.example.com', "Control's host from control.example.com to console.example.com"],
				['--environment=staging', 'the environment name from production to staging'],
			]
		) {
			const refused = run('upgrade', [...WHERE, flag ?? ''], account)
			await expect(refused.result).rejects.toThrow(`an upgrade does not change ${change}`)
			expect(refused.applied).toEqual([])
		}
		const mcp = run('upgrade', [...WHERE, '--mcp-authoring=on'], account)
		await mcp.result
		expect(mcp.lines).toContain('aws: changing MCP authoring from off to on')
		expect(parseAwsInstallationRecord(account.store.get(AWS_INSTALLATION_RECORD) ?? '').mcpAuthoring).toBe(true)
	})

	test('a declined confirmation changes nothing, the record included', async () => {
		const account = fakeAccount()
		const declined = run('install', INSTALL, account, { confirm: async () => false })
		expect(await declined.result).toBeNull()
		expect(declined.applied).toEqual([])
		expect(account.store.has(AWS_INSTALLATION_RECORD)).toBe(false)
		expect(declined.lines.at(-1)).toBe('aws: nothing was changed')
	})

	test("an install's sign-in reaches the parameters; an upgrade's run writes none of it", async () => {
		const account = fakeAccount()
		const install = run('install', INSTALL, account)
		await install.result
		const [input] = install.applied
		if (input === undefined) throw new Error('nothing applied')
		const names = await input.parameters(platformState())
		expect(names.iam).toContain('FABRIKA_IAM_PASSWORD_ENABLED')
		expect(account.store.get('/fabrika/platform/control/FABRIKA_AWS_PROXY_COMMIT_SHA')).toBe(COMMIT)
		// The console's table digest is the manifest's for these hosts.
		expect(account.store.get('/fabrika/platform/control/FABRIKA_SERVICE_TABLE_DIGEST')).toBe(
			awsPlatformManifest(input.plan, { mcp: false }).deployed.controlTableDigest,
		)

		const fresh = fakeAccount()
		fresh.services = 'CREATE_COMPLETE'
		fresh.store.set(AWS_INSTALLATION_RECORD, RECORD)
		const upgrade = run('upgrade', WHERE, fresh)
		await upgrade.result
		const [upgraded] = upgrade.applied
		if (upgraded === undefined) throw new Error('nothing applied')
		// A store without keys: an upgrade of an installation whose keys were lost is refused, not made anew.
		await expect(upgraded.parameters(platformState())).rejects.toThrow('an upgrade never makes a new one')
		expect(fresh.store.has('/fabrika/platform/iam/FABRIKA_IAM_PASSWORD_ENABLED')).toBe(false)
	})

	test("the operator's credentials come from the standard variables, a missing key refused by name", async () => {
		expect(await environmentCredentials({ AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret' }).current()).toEqual({
			accessKeyId: 'AKID',
			secretAccessKey: 'secret',
		})
		expect(await environmentCredentials({ AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'token' }).current())
			.toMatchObject({ sessionToken: 'token' })
		await expect(environmentCredentials({ AWS_ACCESS_KEY_ID: 'AKID' }).current()).rejects.toThrow('AWS_SECRET_ACCESS_KEY')
	})

	test('the module the CLI loads: install, upgrade and the guide', async () => {
		expect(isInstallationCli(installationCli)).toBe(true)
		expect(installationCli.provider).toBe('aws')
		expect([...installationCli.commands]).toEqual(['install', 'upgrade', 'guide'])
		expect(await readAwsInstallationGuide()).toContain('# Installing Fabrika on AWS')
		await expect(installationCli.run('admin', [])).rejects.toThrow('does not support `platform admin`')
	})
})
