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
		expect(options.plan).toEqual({
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
		expect(options.mcpAuthoring).toBe(false)
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
		expect(options.plan.region).toBe('eu-central-1')
		expect(options.plan.vpcCidrs.platform).toBe('10.90.0.0/16')
		expect(options.unattended).toBe(true)
		expect(options.bringUp.authentication).toEqual({
			passwordEnabled: false,
			oidc: { issuer: 'https://login.example.com', clientId: 'fabrika', clientSecret: 'never-quoted' },
		})
		expect(() => parseAwsInstallArgs([...ARGV, '--auth-methods=oidc', '--oidc-issuer=https://login.example.com', '--oidc-client-id=x'], {})).toThrow(
			'FABRIKA_IAM_OIDC_CLIENT_SECRET',
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
	})

	test('an upgrade names no sign-in method and no mailer: they stay as the install or an operator set them', () => {
		expect('bringUp' in parseAwsUpgradeArgs(ARGV, {})).toBe(false)
		expect(() => parseAwsUpgradeArgs([...ARGV, '--auth-methods=password'], {})).toThrow('`--auth-methods` is not an argument of this command')
		expect(() => parseAwsUpgradeArgs([...ARGV, '--email-provider=smtp'], {})).toThrow('`--email-provider` is not an argument of this command')
	})
})
