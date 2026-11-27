// `platform admin` on AWS: the account checked first, the hosts from the installation's record and IAM's provisioning
// key from its Parameter Store (never logged), the console and IAM registered before the first administrator is
// admitted, and the enrollment URL printed once on its own line and never logged.

import { ReconcileSchemaError } from '@fabrika/auth'
import { IAM_APP_ID, IAM_APP_SCHEMA } from '@fabrika/iam-contract'
import { type EnrollmentOutcome, type FirstAdministratorResult, platformProxyAppFor } from '@fabrika/installation-init'
import type { SchemaReconcileInput } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import {
	AWS_PROVISIONING_KEY_PARAMETER,
	type AwsAdminRun,
	AwsIamUnreachableError,
	awsSchemaReconciler,
	parseAwsAdminArgs,
	runAwsAdmin,
} from '../admin'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '../generated/platform-proxy-manifest'
import { awsInstallChoices, parseAwsInstallArgs } from '../options'
import { AWS_INSTALLATION_RECORD, encodeAwsInstallationRecord } from '../record'

const certificate = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const RECORD = encodeAwsInstallationRecord(awsInstallChoices(
	parseAwsInstallArgs([
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
	], {}),
	{ iam: certificate(1), control: certificate(2), operations: certificate(3), apps: certificate(4) },
))
const KEY = 'px_provisioning-never-logged'
const ENROLLMENT = 'https://iam.example.com/enroll#token-never-logged'

/** One account and its IAM: the record and the provisioning key in its Parameter Store, what IAM was asked. */
function account(
	overrides: { readonly caller?: string; readonly store?: ReadonlyMap<string, string>; readonly enrollment?: EnrollmentOutcome } = {},
) {
	const store = new Map(overrides.store ?? [[AWS_INSTALLATION_RECORD, RECORD], [AWS_PROVISIONING_KEY_PARAMETER, KEY]])
	const calls: string[] = []
	const lines: string[] = []
	const printed: string[] = []
	const run = (argv: readonly string[]): Promise<FirstAdministratorResult> => {
		const input: AwsAdminRun = {
			options: parseAwsAdminArgs(argv, {}),
			sts: { callerAccount: async () => overrides.caller ?? '123456789012' },
			secrets: { readSecret: async (name) => store.get(name) ?? null },
			reconcile: async (call: SchemaReconcileInput) => {
				calls.push(`register ${call.app} at ${call.url} ${call.adminKey === KEY ? 'with the key' : 'with another key'}`)
			},
			admit: async (origin, key, request) => {
				calls.push(
					`admit ${request.email} at ${origin} ${key === KEY ? 'with the key' : 'with another key'}${
						request.reissueEnrollment === true ? ', reissuing' : ''
					}`,
				)
				return {
					principalId: '0190a000-0000-7000-8000-000000000001',
					email: request.email,
					principal: 'invited',
					grant: 'created',
					enrollment: overrides.enrollment ?? { state: 'issued', url: ENROLLMENT, expiresAt: 1_800_000_000 },
				}
			},
			signal: new AbortController().signal,
			log: (line) => lines.push(line),
			print: (line) => printed.push(line),
		}
		return runAwsAdmin(input)
	}
	return { run, calls, lines, printed }
}

const ARGV = ['--account-id=123456789012', '--region=eu-central-1', '--email=admin@example.com']

describe('platform admin on AWS', () => {
	test("registers the console and IAM, then admits the address with the installation's own key; the URL printed once, never logged", async () => {
		const { run, calls, lines, printed } = account()
		await run(ARGV)
		expect(calls).toEqual([
			`register ${platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control').id} at https://iam.example.com with the key`,
			`register ${IAM_APP_ID} at https://iam.example.com with the key`,
			'admit admin@example.com at https://iam.example.com with the key',
		])
		expect(printed).toEqual([ENROLLMENT])
		const logged = lines.join('\n')
		expect(logged).not.toContain(ENROLLMENT)
		expect(logged).not.toContain(KEY)
		// When it stops working, as Zerops' `admin` says it: the issued URL's and the emailed one's.
		const until = `valid until ${new Date(1_800_000_000 * 1000).toISOString()}`
		expect(logged).toContain(until)
		const emailed = account({ enrollment: { state: 'emailed', email: 'admin@example.com', expiresAt: 1_800_000_000 } })
		await emailed.run(ARGV)
		expect(emailed.lines).toContain(`aws: the enrollment was emailed to admin@example.com, ${until}`)
	})

	test('another account, no installation, or no key is refused before IAM is asked anything', async () => {
		const other = account({ caller: '210987654321' })
		await expect(other.run(ARGV)).rejects.toThrow("account 210987654321's, not account 123456789012's")
		expect(other.calls).toEqual([])
		const none = account({ store: new Map() })
		await expect(none.run(ARGV)).rejects.toThrow('holds no installation record')
		const keyless = account({ store: new Map([[AWS_INSTALLATION_RECORD, RECORD]]) })
		await expect(keyless.run(ARGV)).rejects.toThrow(`${AWS_PROVISIONING_KEY_PARAMETER} is missing`)
		expect(keyless.calls).toEqual([])
	})

	test('an outstanding enrollment is reported, not replaced, unless --reissue says so; nothing is printed', async () => {
		const outstanding = account({ enrollment: { state: 'outstanding' } })
		await outstanding.run(ARGV)
		expect(outstanding.printed).toEqual([])
		expect(outstanding.lines.some((line) => line.includes('--reissue replaces it'))).toBe(true)
		const reissued = account()
		await reissued.run([...ARGV, '--reissue'])
		expect(reissued.calls.at(-1)).toBe('admit admin@example.com at https://iam.example.com with the key, reissuing')
	})

	test("the reconciler: IAM's answer is a refusal, no answer is unreachable, an abort stays the abort", async () => {
		const call = (url: string, signal: AbortSignal = new AbortController().signal) =>
			awsSchemaReconciler({ url, app: IAM_APP_ID, schema: IAM_APP_SCHEMA, adminKey: KEY, signal })
		const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ error: 'unauthorized' }, { status: 401 }) })
		try {
			await expect(call(`http://127.0.0.1:${server.port}`)).rejects.toBeInstanceOf(ReconcileSchemaError)
		} finally {
			await server.stop(true)
		}
		// Nothing listens on port 1: the connection is refused, and the error names the origin, never the key.
		const unreachable = await call('http://127.0.0.1:1').then(() => null, (error: unknown) => error)
		expect(unreachable).toBeInstanceOf(AwsIamUnreachableError)
		expect(String(unreachable)).toContain('IAM at http://127.0.0.1:1 gave no answer')
		expect(String(unreachable)).not.toContain(KEY)
		const aborted = new AbortController()
		aborted.abort()
		const abort = await call('http://127.0.0.1:1', aborted.signal).then(() => null, (error: unknown) => error)
		expect(abort).not.toBeNull()
		expect(abort).not.toBeInstanceOf(AwsIamUnreachableError)
	})

	test('its arguments: the account, the region and the mailbox; a key has no flag', () => {
		expect(parseAwsAdminArgs(ARGV, {})).toEqual({ accountId: '123456789012', region: 'eu-central-1', email: 'admin@example.com', reissue: false })
		expect(parseAwsAdminArgs(['--account-id=123456789012', '--region=eu-central-1'], { FABRIKA_PLATFORM_ADMIN_EMAIL: 'a@example.com' }).email).toBe(
			'a@example.com',
		)
		expect(() => parseAwsAdminArgs([...ARGV, '--key=px_hidden'], {})).toThrow('`--key` is not an argument of this command')
		// `--reissue` is bare, every other flag takes `=`: neither is guessed.
		expect(parseAwsAdminArgs([...ARGV, '--reissue'], {}).reissue).toBe(true)
		expect(() => parseAwsAdminArgs([...ARGV, '--reissue=yes'], {})).toThrow('--reissue takes no value')
		expect(() => parseAwsAdminArgs(['--account-id=123456789012', '--region=eu-central-1', '--email', 'a@example.com'], {})).toThrow(
			'--email takes its value as --email=<value>',
		)
		expect(() => parseAwsAdminArgs(['--account-id=1', '--region=eu-central-1', '--email=a@example.com'], {})).toThrow(
			'--account-id is not an account id',
		)
		expect(() => parseAwsAdminArgs(['--account-id=123456789012', '--region=eu-central-1'], {})).toThrow(
			'--email=<value> or FABRIKA_PLATFORM_ADMIN_EMAIL',
		)
	})
})
