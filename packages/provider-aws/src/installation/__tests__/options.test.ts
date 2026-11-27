// What `install` and `upgrade` read: every value from its flag or the variable beside it, the defaults, a credential
// from the environment alone, and each value of another form refused by its flag, never quoting it.

import { describe, expect, test } from 'bun:test'
import { AWS_PLATFORM_REPOSITORY, parseAwsInstallArgs, parseAwsUpgradeArgs } from '../options'

const certificate = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const COMMIT = 'a'.repeat(40)
const BASE_IMAGE = `docker.io/oven/bun@sha256:${'b'.repeat(64)}`
const ARGV = [
	'--account-id=123456789012',
	'--region=eu-central-1',
	'--environment=production',
	'--iam-host=IAM.example.com',
	'--control-host=control.example.com',
	'--operations-host=operations.example.com',
	`--iam-certificate=${certificate(1)}`,
	`--control-certificate=${certificate(2)}`,
	`--operations-certificate=${certificate(3)}`,
	'--apps-host=apps.example.com',
	`--apps-certificate=${certificate(4)}`,
	`--commit=${COMMIT}`,
	`--base-image=${BASE_IMAGE}`,
]

describe("the AWS installation's options", () => {
	test('an install: the plan, the release, password sign-in and no mail unless named', () => {
		const options = parseAwsInstallArgs(ARGV, {})
		expect(options.choices.plan).toEqual({
			accountId: '123456789012',
			region: 'eu-central-1',
			vpcCidrs: { apps: '10.80.0.0/16', platform: '10.81.0.0/16' },
			// Hosts lower-case, as the balancers and the manifest compare them.
			hosts: { iam: 'iam.example.com', control: 'control.example.com', operations: 'operations.example.com' },
			certificates: { iam: certificate(1), control: certificate(2), operations: certificate(3) },
			appsDefault: { host: 'apps.example.com', certificate: certificate(4) },
		})
		expect(options.release).toEqual({ repository: AWS_PLATFORM_REPOSITORY, commitSha: COMMIT })
		expect(options.baseImage).toBe(BASE_IMAGE)
		expect(options.choices.mcpAuthoring).toBe(false)
		expect(options.choices.environment).toBe('production')
		expect(options.unattended).toBe(false)
		expect(options.bringUp).toEqual({ authentication: { passwordEnabled: true }, email: { kind: 'none' } })
	})

	test('each value may come from its variable instead, and the OIDC secret from the environment alone', () => {
		const options = parseAwsInstallArgs(
			[...ARGV.filter((arg) => !arg.startsWith('--region') && !arg.startsWith('--commit')), '--auth-methods=oidc', '--oidc-client-id=fabrika', '--yes'],
			{
				FABRIKA_AWS_REGION: 'eu-central-1',
				FABRIKA_PLATFORM_COMMIT: COMMIT,
				FABRIKA_IAM_OIDC_ISSUER: 'https://login.example.com',
				FABRIKA_IAM_OIDC_CLIENT_SECRET: 'never-quoted',
				FABRIKA_AWS_PLATFORM_VPC_CIDR: '10.90.0.0/16',
			},
		)
		expect(options.region).toBe('eu-central-1')
		expect(options.choices.plan.vpcCidrs.platform).toBe('10.90.0.0/16')
		expect(options.unattended).toBe(true)
		expect(options.bringUp.authentication).toEqual({
			passwordEnabled: false,
			oidc: { issuer: 'https://login.example.com', clientId: 'fabrika', clientSecret: 'never-quoted' },
		})
		expect(() => parseAwsInstallArgs([...ARGV, '--auth-methods=oidc', '--oidc-issuer=https://login.example.com', '--oidc-client-id=x'], {})).toThrow(
			'FABRIKA_IAM_OIDC_CLIENT_SECRET is required in the environment (it has no flag)',
		)
	})

	test('a value of another form is refused by its flag, never quoting it', () => {
		const refused = (argv: readonly string[]) => {
			try {
				parseAwsInstallArgs(argv, {})
			} catch (error) {
				return String(error)
			}
			return 'accepted'
		}
		const swap = (flag: string, value: string) => [...ARGV.filter((arg) => !arg.startsWith(`${flag}=`)), `${flag}=${value}`]
		expect(refused(swap('--commit', 'main-secret-branch'))).toContain('--commit is not')
		expect(refused(swap('--commit', 'main-secret-branch'))).not.toContain('main-secret-branch')
		expect(refused(swap('--base-image', 'oven/bun:latest'))).toContain('--base-image is not an image by digest')
		expect(refused(swap('--environment', 'Prod Env'))).toContain('--environment is not')
		expect(refused(swap('--repository', 'not a repo'))).toContain('--repository is not owner/name')
		expect(refused(swap('--mcp-authoring', 'maybe'))).toContain('--mcp-authoring must be on or off')
		expect(refused([...ARGV, '--token=hidden'])).toContain('`--token` is not an argument of this command')
		expect(refused([...ARGV, '--token=hidden'])).not.toContain('hidden')
		expect(refused(ARGV.filter((arg) => !arg.startsWith('--account-id')))).toContain('--account-id')
		// The account and the region are checked before any call is made with them.
		expect(refused(swap('--account-id', '12345'))).toContain('--account-id is not an account id')
		expect(refused(swap('--region', 'eu-central-1.evil'))).toContain('--region is not a region name')
	})

	test('an upgrade names only what it changes; sign-in and mail are no arguments of it', () => {
		const upgrade = parseAwsUpgradeArgs(['--account-id=123456789012', '--region=eu-central-1', `--commit=${COMMIT}`, `--base-image=${BASE_IMAGE}`], {})
		expect(upgrade.named).toEqual({})
		expect('bringUp' in upgrade).toBe(false)
		const renewed = parseAwsUpgradeArgs(
			[
				'--account-id=123456789012',
				'--region=eu-central-1',
				`--commit=${COMMIT}`,
				`--base-image=${BASE_IMAGE}`,
				`--control-certificate=${certificate(9)}`,
				'--iam-host=IAM.example.com',
			],
			{},
		)
		expect(renewed.named).toEqual({ controlCertificate: certificate(9), iamHost: 'iam.example.com' })
		expect(() => parseAwsUpgradeArgs([...ARGV, '--auth-methods=password'], {})).toThrow('`--auth-methods` is not an argument of this command')
		expect(() => parseAwsUpgradeArgs([...ARGV, '--email-provider=smtp'], {})).toThrow('`--email-provider` is not an argument of this command')
	})

	test("an install's choices are each required, a network's range alone taking its default", () => {
		expect(() => parseAwsInstallArgs(ARGV.filter((arg) => !arg.startsWith('--iam-host')), {})).toThrow(
			'--iam-host=<value> or FABRIKA_PLATFORM_IAM_HOST is required',
		)
		expect(() => parseAwsInstallArgs(ARGV.filter((arg) => !arg.startsWith('--environment')), {})).toThrow('--environment=<value>')
	})
})
