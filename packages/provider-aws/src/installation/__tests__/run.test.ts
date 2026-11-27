// The commands' run: an install refused where an installation exists and an upgrade where none does, nothing written
// when the operator declines, the bring-up's values reaching the parameters on an install alone, the operator's
// credentials from the environment, and the module the CLI loads.

import type { Confirmations } from '@fabrika/installation-init'
import { isInstallationCli } from '@fabrika/provider-contract/installation'
import { describe, expect, test } from 'bun:test'
import type { SsmPlatformSecrets } from '../../aws/ssm'
import type { AwsPlatformApplied, AwsPlatformApplyInput } from '../apply'
import { installationCli, readAwsInstallationGuide } from '../index'
import { parseAwsInstallArgs, parseAwsUpgradeArgs } from '../options'
import { type AwsPlatformClients, environmentCredentials, runAwsPlatform } from '../run'
import { platformState } from './platform-fixture'

const certificate = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ARGV = [
	'--account-id=123456789012',
	'--region=eu-central-1',
	'--environment=production',
	'--iam-host=iam.example.com',
	'--control-host=control.example.com',
	'--operations-host=operations.example.com',
	`--iam-certificate=${certificate(1)}`,
	`--control-certificate=${certificate(2)}`,
	`--operations-certificate=${certificate(3)}`,
	'--apps-host=apps.example.com',
	`--apps-certificate=${certificate(4)}`,
	`--commit=${'a'.repeat(40)}`,
	`--base-image=docker.io/oven/bun@sha256:${'b'.repeat(64)}`,
]

/** Parameter Store in memory, holding the database's passwords as the run writes them before the database. */
function fakeSecrets(): { readonly secrets: SsmPlatformSecrets; readonly store: Map<string, string> } {
	const store = new Map<string, string>()
	for (const service of ['iam', 'control', 'operations']) {
		store.set(`/fabrika/platform/database/${service}-password`, `${service.padEnd(8, 'x')}${'P'.repeat(32)}`)
	}
	return {
		store,
		secrets: {
			putSecretOnce: async (name, value) => {
				if (store.has(name)) return false
				store.set(name, value)
				return true
			},
			putSecret: async (name, value) => {
				store.set(name, value)
			},
			readSecret: async (name) => store.get(name) ?? null,
			listNames: async (path) => [...store.keys()].filter((name) => name.startsWith(`${path}/`)).sort(),
		},
	}
}

/** Clients that answer whether the services' stack exists and refuse anything else a test did not expect. */
function fakeClients(servicesExist: boolean, secrets: SsmPlatformSecrets): AwsPlatformClients {
	const unexpected = async (): Promise<never> => {
		throw new Error('unexpected call')
	}
	return {
		cloudFormation: {
			findStack: async (name) => (servicesExist && name === 'fabrika-platform-services' ? { stackId: 'x', status: 'CREATE_COMPLETE' } : null),
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

function run(kind: 'install' | 'upgrade', servicesExist: boolean, confirmations: Confirmations = yes) {
	const { secrets, store } = fakeSecrets()
	const applied: AwsPlatformApplyInput[] = []
	const lines: string[] = []
	const options = kind === 'install' ? parseAwsInstallArgs(ARGV, {}) : parseAwsUpgradeArgs(ARGV, {})
	const result = runAwsPlatform({
		kind,
		options,
		clients: fakeClients(servicesExist, secrets),
		confirmations,
		signal: new AbortController().signal,
		sleep: async () => {},
		log: (line) => lines.push(line),
		apply: async (input): Promise<AwsPlatformApplied> => {
			applied.push(input)
			return { ...platformState(), images: { services: `sha256:${'1'.repeat(64)}`, proxy: `sha256:${'2'.repeat(64)}` } }
		},
	})
	return { result, applied, lines, store }
}

describe("the AWS installation's commands", () => {
	test('an install where an installation exists, or an upgrade where none does, is refused before anything', async () => {
		const install = run('install', true)
		await expect(install.result).rejects.toThrow('already holds an installation; `platform upgrade` moves it to a release')
		expect(install.applied).toEqual([])
		const upgrade = run('upgrade', false)
		await expect(upgrade.result).rejects.toThrow('holds no installation yet; `platform install` makes one')
		expect(upgrade.applied).toEqual([])
	})

	test('a declined confirmation changes nothing', async () => {
		const declined = run('install', false, { confirm: async () => false })
		expect(await declined.result).toBeNull()
		expect(declined.applied).toEqual([])
		expect(declined.lines.at(-1)).toBe('aws: nothing was changed')
	})

	test("an install's sign-in reaches the parameters; an upgrade's run writes none of it", async () => {
		const install = run('install', false)
		await install.result
		const [input] = install.applied
		if (input === undefined) throw new Error('nothing applied')
		expect(input.plan.hosts.iam).toBe('iam.example.com')
		const names = await input.parameters(platformState())
		expect(names.iam).toContain('FABRIKA_IAM_PASSWORD_ENABLED')
		expect(install.store.get('/fabrika/platform/control/FABRIKA_AWS_PROXY_COMMIT_SHA')).toBe('a'.repeat(40))
		// The console's table digest is the manifest's for these hosts.
		expect(install.store.get('/fabrika/platform/control/FABRIKA_SERVICE_TABLE_DIGEST')).toMatch(/^[0-9a-f]{64}$/)

		const upgrade = run('upgrade', true)
		await upgrade.result
		const [upgraded] = upgrade.applied
		if (upgraded === undefined) throw new Error('nothing applied')
		// A fresh store: an upgrade of an installation whose keys were lost is refused, not made anew.
		await expect(upgraded.parameters(platformState())).rejects.toThrow('an upgrade never makes a new one')
		expect(upgrade.store.has('/fabrika/platform/iam/FABRIKA_IAM_PASSWORD_ENABLED')).toBe(false)
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
