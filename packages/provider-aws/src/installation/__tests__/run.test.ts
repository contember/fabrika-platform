// The commands' run: credentials of another account refused first; an install refused where an installation exists
// (naming the upgrade that finishes one) and an upgrade where none does; the installation's choices recorded by an
// install and taken by an upgrade, a changed range, host or environment refused and a changed certificate named;
// nothing written when the operator declines; the bring-up's values reaching the parameters on an install alone; the
// operator's credentials from the environment; and the module the CLI loads.

import { ReconcileSchemaError } from '@fabrika/auth'
import { IAM_APP_ID } from '@fabrika/iam-contract'
import { type Confirmations, platformProxyAppFor } from '@fabrika/installation-init'
import type { SchemaReconcileInput } from '@fabrika/provider-contract'
import { isInstallationCli } from '@fabrika/provider-contract/installation'
import { describe, expect, test } from 'bun:test'
import type { Certificate, CertificateSummary } from '../../aws/acm'
import type { StackStatus } from '../../aws/cloudformation'
import type { SsmPlatformSecrets } from '../../aws/ssm'
import { AWS_PROVISIONING_KEY_PARAMETER, AwsIamUnreachableError } from '../admin'
import type { AwsPlatformApplied, AwsPlatformApplyInput } from '../apply'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '../generated/platform-proxy-manifest'
import { installationCli, readAwsInstallationGuide } from '../index'
import { awsInstallChoices, parseAwsInstallArgs, parseAwsUpgradeArgs } from '../options'
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
/** The certificates `INSTALL` names. */
const NAMED = { iam: certificate(1), control: certificate(2), operations: certificate(3), apps: certificate(4) }
/** The record an install with `INSTALL` writes. */
const RECORD = encodeAwsInstallationRecord(awsInstallChoices(parseAwsInstallArgs(INSTALL, {}), NAMED))
/** The hosts `INSTALL` names, by the certificate each takes. */
const HOSTS = { iam: 'iam.example.com', control: 'control.example.com', operations: 'operations.example.com', apps: 'apps.example.com' }
const issued = (arn: string, host: string): Certificate => ({ arn, host, status: 'ISSUED', validation: null, inUseBy: [] })

/** One account: its Parameter Store in memory, its services' stack's status if it has one, its credentials' account. */
interface FakeAccount {
	readonly store: Map<string, string>
	services: StackStatus | null
	callerAccount: string
	readonly calls: string[]
	/** The range each network stack holds. */
	readonly networks: { readonly apps: string; readonly platform: string }
	/** Its certificates, oldest first, and the hosts it was asked to request one for. */
	readonly certificates: Map<string, Certificate>
	readonly requested: string[]
}

function fakeAccount(): FakeAccount {
	const store = new Map<string, string>()
	for (const service of ['iam', 'control', 'operations']) {
		store.set(`/fabrika/platform/database/${service}-password`, `${service.padEnd(8, 'x')}${'P'.repeat(32)}`)
	}
	store.set(AWS_PROVISIONING_KEY_PARAMETER, PROVISIONING_KEY)
	const certificates = new Map<string, Certificate>()
	for (const [slot, arn] of Object.entries(NAMED)) certificates.set(arn, issued(arn, HOSTS[slotOf(slot)]))
	// Control's, renewed under a new ARN.
	certificates.set(certificate(9), issued(certificate(9), HOSTS.control))
	return {
		store,
		services: null,
		callerAccount: '123456789012',
		calls: [],
		networks: { apps: '10.80.0.0/16', platform: '10.81.0.0/16' },
		certificates,
		requested: [],
	}
}

function slotOf(name: string): 'iam' | 'control' | 'operations' | 'apps' {
	if (name === 'iam' || name === 'control' || name === 'operations' || name === 'apps') return name
	throw new Error(`no slot ${name}`)
}

const PROVISIONING_KEY = 'px_provisioning-never-logged'

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
		acm: {
			describeCertificate: async (arn) => account.certificates.get(arn) ?? null,
			findCertificates: async (host) =>
				[...account.certificates.values()]
					.filter((found) => found.host === host && (found.status === 'ISSUED' || found.status === 'PENDING_VALIDATION'))
					.map((found, index): CertificateSummary => ({
						arn: found.arn,
						host,
						status: found.status === 'ISSUED' ? 'ISSUED' : 'PENDING_VALIDATION',
						createdAt: index,
					}))
					.reverse(),
			requestCertificate: async ({ host }) => {
				account.requested.push(host)
				const arn = certificate(100 + account.requested.length)
				account.certificates.set(arn, {
					arn,
					host,
					status: 'PENDING_VALIDATION',
					validation: { name: `_a1.${host}.`, value: `_b2.abcdefgh.acm-validations.aws.` },
					inUseBy: [],
				})
				return arn
			},
		},
		cloudFormation: {
			findStack: async (name) => {
				account.calls.push(`find ${name}`)
				if (name === 'fabrika-platform-network-apps' || name === 'fabrika-platform-network-platform') return { stackId: name, status: 'CREATE_COMPLETE' }
				return account.services !== null && name === 'fabrika-platform-services' ? { stackId: 'x', status: account.services } : null
			},
			describeStack: async (id) => ({
				stackId: id,
				status: 'CREATE_COMPLETE',
				outputs: { VpcCidr: id === 'fabrika-platform-network-apps' ? account.networks.apps : account.networks.platform },
			}),
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

function run(
	kind: 'install' | 'upgrade',
	argv: readonly string[],
	account: FakeAccount,
	confirmations: Confirmations = yes,
	answer: (call: SchemaReconcileInput) => Promise<void> = async () => {},
) {
	const applied: AwsPlatformApplyInput[] = []
	const registered: SchemaReconcileInput[] = []
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
		reconcile: async (call: SchemaReconcileInput) => {
			await answer(call)
			registered.push(call)
		},
	}
	const result = kind === 'install'
		? runAwsPlatform({ kind, options: parseAwsInstallArgs(argv, {}), ...shared })
		: runAwsPlatform({ kind, options: parseAwsUpgradeArgs(argv, {}), ...shared })
	return { result, applied, lines, registered }
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
		// Resumed with another host: refused as a resumed install's change, before the record's certificate is read
		// against a host the installation does not have.
		const otherHost = run('install', INSTALL.map((arg) => (arg.startsWith('--iam-host=') ? '--iam-host=login.example.com' : arg)), account)
		await expect(otherHost.result).rejects.toThrow(
			"an install that stopped part way is resumed with its own choices, and these differ: IAM's host from iam.example.com to login.example.com",
		)
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

	test('an upgrade registers the console and IAM with the key read from the installation; an install names that next step', async () => {
		const account = fakeAccount()
		account.services = 'CREATE_COMPLETE'
		account.store.set(AWS_INSTALLATION_RECORD, RECORD)
		const upgrade = run('upgrade', WHERE, account)
		await upgrade.result
		expect(upgrade.registered.map((call) => [call.url, call.app, call.returnOrigins, call.adminKey])).toEqual([
			[
				'https://iam.example.com',
				platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control').id,
				['https://control.example.com'],
				PROVISIONING_KEY,
			],
			['https://iam.example.com', IAM_APP_ID, undefined, PROVISIONING_KEY],
		])
		expect(upgrade.lines.join('\n')).not.toContain(PROVISIONING_KEY)
		const install = run('install', INSTALL, fakeAccount())
		await install.result
		expect(install.registered).toEqual([])
		expect(install.lines.some((line) => line.includes('`platform admin --provider=aws`'))).toBe(true)
	})

	test('an upgrade whose IAM gives no answer names `admin` and succeeds; an answer from IAM that refuses fails it', async () => {
		const account = fakeAccount()
		account.services = 'CREATE_COMPLETE'
		account.store.set(AWS_INSTALLATION_RECORD, RECORD)
		// The hosts point nowhere yet: an upgrade that finishes a stopped install.
		const unreachable = run('upgrade', WHERE, account, yes, async (call) => {
			throw new AwsIamUnreachableError(call.url, 'Unable to connect')
		})
		expect(await unreachable.result).not.toBeNull()
		expect(unreachable.applied).toHaveLength(1)
		expect(unreachable.lines).toContain(
			"aws: IAM at https://iam.example.com gave no answer (Unable to connect); the release is applied, but the console and IAM's vocabulary are not registered",
		)
		expect(unreachable.lines.some((line) => line.includes('`platform admin --provider=aws` registers them'))).toBe(true)
		const refused = run('upgrade', WHERE, account, yes, async () => {
			throw new ReconcileSchemaError('PUT /admin/apps/console/schema failed (401): unauthorized', 401)
		})
		await expect(refused.result).rejects.toThrow('failed (401)')
	})

	test('a lost record is written back by an upgrade that names every choice, each checked against what the installation holds', async () => {
		const account = fakeAccount()
		account.services = 'CREATE_COMPLETE'
		// What the last run wrote: the hosts in Control's parameters, the environment's name in IAM's.
		account.store.set(
			'/fabrika/platform/control/FABRIKA_AWS_INSTALLATION_HOSTS',
			'iam.example.com,control.example.com,operations.example.com,apps.example.com',
		)
		account.store.set('/fabrika/platform/iam/ENVIRONMENT', 'production')
		const partial = run('upgrade', [...WHERE, '--iam-host=iam.example.com'], account)
		await expect(partial.result).rejects.toThrow("restore it from the keys' backup, or name every choice to write it back (missing: --apps-vpc-cidr")
		// MCP authoring is a choice like the rest: never defaulted to off on the way back.
		const withoutMcp = [...INSTALL, '--apps-vpc-cidr=10.80.0.0/16', '--platform-vpc-cidr=10.81.0.0/16']
		await expect(run('upgrade', withoutMcp, account).result).rejects.toThrow('(missing: --mcp-authoring)')
		const everything = [...withoutMcp, '--mcp-authoring=off']
		const swap = (flag: string, value: string) => everything.map((arg) => (arg.startsWith(`${flag}=`) ? `${flag}=${value}` : arg))
		// A range the network does not hold is refused, even with the record gone.
		const wrong = run('upgrade', swap('--platform-vpc-cidr', '10.90.0.0/16'), account)
		await expect(wrong.result).rejects.toThrow('the platform network holds 10.81.0.0/16, not the 10.90.0.0/16 named')
		expect(wrong.applied).toEqual([])
		// So is a host or an environment the installation does not have: a typo would move the balancer's rule.
		const typo = run('upgrade', swap('--iam-host', 'iam.exmaple.com'), account)
		await expect(typo.result).rejects.toThrow(
			'the installation holds iam.example.com,control.example.com,operations.example.com,apps.example.com as the hosts',
		)
		const staging = run('upgrade', swap('--environment', 'staging'), account)
		await expect(staging.result).rejects.toThrow("the installation holds production as the environment's name")
		expect([...typo.applied, ...staging.applied]).toEqual([])
		expect(account.store.has(AWS_INSTALLATION_RECORD)).toBe(false)
		const rebuilt = run('upgrade', everything, account)
		await rebuilt.result
		expect(rebuilt.lines).toContain('aws: changing the installation record, written back from the choices named')
		expect(account.store.get(AWS_INSTALLATION_RECORD)).toBe(RECORD)
	})

	test('an install without certificates requests one for exactly each host, prints the records, and goes on once ACM issued them', async () => {
		const bare = INSTALL.filter((arg) => !arg.includes('-certificate='))
		const declining = fakeAccount()
		declining.certificates.clear()
		const declined = run('install', bare, declining, { confirm: async () => false })
		expect(await declined.result).toBeNull()
		expect(declining.requested).toEqual([])
		expect(declined.lines).toContain('aws: nothing was changed; name a certificate for each host instead')

		const account = fakeAccount()
		account.certificates.clear()
		const first = run('install', bare, account)
		expect(await first.result).toBeNull()
		expect(account.requested).toEqual(Object.values(HOSTS))
		expect(first.applied).toEqual([])
		expect(account.store.has(AWS_INSTALLATION_RECORD)).toBe(false)
		expect(first.lines).toContain('aws: iam.example.com: add the DNS record CNAME _a1.iam.example.com. -> _b2.abcdefgh.acm-validations.aws.')
		// Run again while ACM waits for the records: the same certificates found, none requested anew, still stopped.
		const waiting = run('install', bare, account)
		expect(await waiting.result).toBeNull()
		expect(account.requested).toHaveLength(4)
		expect(waiting.applied).toEqual([])
		// Issued: found, recorded, and the install goes on.
		for (const [arn, found] of account.certificates) account.certificates.set(arn, { ...found, status: 'ISSUED' })
		const done = run('install', bare, account)
		expect(await done.result).not.toBeNull()
		expect(account.requested).toHaveLength(4)
		expect(parseAwsInstallationRecord(account.store.get(AWS_INSTALLATION_RECORD) ?? '').plan.certificates).toEqual({
			iam: certificate(101),
			control: certificate(102),
			operations: certificate(103),
		})
	})

	test("a named certificate is refused when it is another host's or region's, missing, or no longer issued; a pending one stops the install", async () => {
		const account = fakeAccount()
		const swap = (flag: string, value: string) => INSTALL.map((arg) => (arg.startsWith(`${flag}=`) ? `${flag}=${value}` : arg))
		// IAM's on the applications' listener would serve IAM's host there.
		await expect(run('install', swap('--apps-certificate', certificate(1)), account).result).rejects.toThrow(
			`--apps-certificate ${certificate(1)} is iam.example.com's, not apps.example.com's`,
		)
		await expect(run('install', swap('--apps-certificate', certificate(4).replace('eu-central-1', 'us-east-1')), account).result).rejects.toThrow(
			'a balancer in eu-central-1 takes its own account',
		)
		await expect(run('install', swap('--apps-certificate', certificate(50)), account).result).rejects.toThrow(
			`--apps-certificate ${certificate(50)} is no certificate in account 123456789012, eu-central-1`,
		)
		account.certificates.set(certificate(4), { ...issued(certificate(4), HOSTS.apps), status: 'EXPIRED' })
		await expect(run('install', INSTALL, account).result).rejects.toThrow(`(${certificate(4)}) is EXPIRED; name another with --apps-certificate`)
		const validation = { name: '_c3.apps.example.com.', value: '_d4.abcdefgh.acm-validations.aws.' }
		account.certificates.set(certificate(4), { ...issued(certificate(4), HOSTS.apps), status: 'PENDING_VALIDATION', validation })
		const pending = run('install', INSTALL, account)
		expect(await pending.result).toBeNull()
		expect(pending.applied).toEqual([])
		expect(pending.lines).toContain(`aws: apps.example.com: add the DNS record CNAME ${validation.name} -> ${validation.value}`)
		expect(account.requested).toEqual([])
		expect(account.store.has(AWS_INSTALLATION_RECORD)).toBe(false)
	})

	test('an upgrade requests no certificate and refuses one no longer issued, until another is named', async () => {
		const account = fakeAccount()
		account.services = 'CREATE_COMPLETE'
		account.store.set(AWS_INSTALLATION_RECORD, RECORD)
		account.certificates.set(certificate(2), { ...issued(certificate(2), HOSTS.control), status: 'REVOKED' })
		const upgrade = run('upgrade', WHERE, account)
		await expect(upgrade.result).rejects.toThrow(`(${certificate(2)}) is REVOKED; name another with --control-certificate`)
		expect(upgrade.applied).toEqual([])
		expect(account.requested).toEqual([])
		const renewed = run('upgrade', [...WHERE, `--control-certificate=${certificate(9)}`], account)
		expect(await renewed.result).not.toBeNull()
		expect(account.requested).toEqual([])
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
		expect([...installationCli.commands]).toEqual(['install', 'upgrade', 'admin', 'guide'])
		expect(await readAwsInstallationGuide()).toContain('# Installing Fabrika on AWS')
		await expect(installationCli.run('deploy', [])).rejects.toThrow('does not support `platform deploy`')
	})
})
