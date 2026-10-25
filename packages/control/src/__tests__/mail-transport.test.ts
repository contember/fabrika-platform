import { CONTRACT_FORMAT, type ContractArtifact, type DeclaredReach } from '@fabrika/auth-core'
import { builtinEmailProviders, builtinEmailProviderSince } from '@fabrika/email/providers'
import { describe, expect, test } from 'bun:test'
import {
	CLOUDFLARE_MAIL_REMEDY,
	type InstallationMail,
	installationMailEnvironment,
	installationMailJobs,
	installationMailSecrets,
	NO_INSTALLATION_MAIL,
	platformMailEnvironment,
	platformMailOrigin,
	readInstallationMail,
	relaysInstallationMail,
	ZEROPS_MAIL_REMEDY,
} from '../mail-transport'

const REACH: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }

/** An artifact whose only interesting part is the reach its sites declare. */
const artifact = (declared: Record<string, DeclaredReach>): ContractArtifact => ({
	format: CONTRACT_FORMAT,
	app: 'notes',
	dimensions: {},
	actions: {},
	roles: {},
	mounts: {},
	files: {},
	jobs: {},
	exports: {},
	imports: {},
	csp: { connectSrc: [], imgSrc: [], frameAncestors: [] },
	tables: {},
	endpoints: [],
	reservedPrefixes: [],
	declared,
})

const VARIABLES = { FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'mail@example.test', FABRIKA_EMAIL_RESEND_API_KEY: 're_key' }
const TRANSPORT: InstallationMail = { kind: 'transport', transport: { variables: VARIABLES, secretNames: new Set(['FABRIKA_EMAIL_RESEND_API_KEY']) } }
const INVALID: InstallationMail = {
	kind: 'invalid',
	reason: 'Email configuration is invalid: FABRIKA_EMAIL_RESEND_API_KEY is missing',
	remedy: ZEROPS_MAIL_REMEDY,
}

describe('the installation mail transport', () => {
	test('none, or no provider at all, reads as none', () => {
		expect(readInstallationMail({}, builtinEmailProviders, ZEROPS_MAIL_REMEDY)).toEqual({ kind: 'none' })
		expect(readInstallationMail({ FABRIKA_EMAIL_PROVIDER: 'none', FABRIKA_EMAIL_FROM: 'mail@example.test' }, builtinEmailProviders, ZEROPS_MAIL_REMEDY))
			.toEqual({
				kind: 'none',
			})
	})

	test("a transport takes only the selected provider's variables, and names its secret ones", () => {
		const mail = readInstallationMail(
			{
				FABRIKA_EMAIL_PROVIDER: 'smartemailing',
				FABRIKA_EMAIL_FROM: 'mail@example.test',
				FABRIKA_EMAIL_FROM_NAME: 'Notes',
				FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user@example.test',
				FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se-key',
				FABRIKA_EMAIL_RESEND_API_KEY: 'stale-resend-key',
				FABRIKA_EMAIL_SMARTEMAILING_TAG: '',
			},
			builtinEmailProviders,
			ZEROPS_MAIL_REMEDY,
		)
		if (mail.kind !== 'transport') throw new Error(`expected a transport, read ${mail.kind}`)
		expect(mail.transport.variables).toEqual({
			FABRIKA_EMAIL_PROVIDER: 'smartemailing',
			FABRIKA_EMAIL_FROM: 'mail@example.test',
			FABRIKA_EMAIL_FROM_NAME: 'Notes',
			FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user@example.test',
			FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se-key',
		})
		expect([...mail.transport.secretNames].sort()).toEqual(['FABRIKA_EMAIL_SMARTEMAILING_API_KEY', 'FABRIKA_EMAIL_SMARTEMAILING_USERNAME'])
	})

	test('an invalid transport reads as invalid, with a reason that names the variable and never a value', () => {
		const mail = readInstallationMail(
			{ FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'private@example.test' },
			builtinEmailProviders,
			ZEROPS_MAIL_REMEDY,
		)
		expect(mail).toEqual({ kind: 'invalid', reason: expect.stringContaining('FABRIKA_EMAIL_RESEND_API_KEY is missing'), remedy: ZEROPS_MAIL_REMEDY })
		expect(JSON.stringify(mail)).not.toContain('private@example.test')
		expect(readInstallationMail({ FABRIKA_EMAIL_PROVIDER: 'smtp' }, builtinEmailProviders, ZEROPS_MAIL_REMEDY)).toEqual({
			kind: 'invalid',
			reason: expect.stringContaining('FABRIKA_EMAIL_PROVIDER must be none or one of'),
			remedy: ZEROPS_MAIL_REMEDY,
		})
	})

	test("only jobs that declare the installation's transport need it, in name order", () => {
		const declared = artifact({
			'job:weekly': { ...REACH, mailer: 'installation' },
			'job:own': { ...REACH, mailer: 'own' },
			'job:digest': { ...REACH, mailer: 'installation' },
			'job:quiet': REACH,
			'api.mail.test': { ...REACH, then: 'digest' },
		})
		expect(installationMailJobs(declared)).toEqual(['digest', 'weekly'])
		expect(installationMailJobs(artifact({ 'job:own': { ...REACH, mailer: 'own' } }))).toEqual([])
		expect(installationMailJobs(null)).toEqual([])
	})

	test('a deploy hands the transport only when a job needs it, and redacts only its secrets', () => {
		const needs = artifact({ 'job:digest': { ...REACH, mailer: 'installation' } })
		expect(installationMailEnvironment(TRANSPORT, needs, '0.8.1')).toEqual(VARIABLES)
		expect(installationMailSecrets(TRANSPORT, VARIABLES)).toEqual(['re_key'])
		expect(installationMailEnvironment(TRANSPORT, artifact({ 'job:own': { ...REACH, mailer: 'own' } }), '0.8.1')).toEqual({})
		expect(installationMailEnvironment(NO_INSTALLATION_MAIL, null, '0.8.1')).toEqual({})
		expect(installationMailEnvironment(INVALID, null, '0.8.1')).toEqual({})
	})

	test('an installation without a transport hands the explicit none, so the application tells it from a missing variable', () => {
		const needs = artifact({ 'job:digest': { ...REACH, mailer: 'installation' } })
		expect(installationMailEnvironment(NO_INSTALLATION_MAIL, needs, '0.8.1')).toEqual({ FABRIKA_EMAIL_PROVIDER: 'none' })
		expect(installationMailSecrets(NO_INSTALLATION_MAIL, { FABRIKA_EMAIL_PROVIDER: 'none' })).toEqual([])
	})

	test('an invalid transport refuses only a contract that needs it, naming each job and the operator step', () => {
		expect(() => installationMailEnvironment(INVALID, artifact({ 'job:digest': { ...REACH, mailer: 'installation' } }), '0.8.1')).toThrow(
			"the contract's job `digest` sends mail through the installation (mailer: 'installation'), and Control's mail transport is invalid: Email configuration is invalid: FABRIKA_EMAIL_RESEND_API_KEY is missing; set FABRIKA_EMAIL_* on both iam and control: see `fabrika platform guide --provider=zerops`, 'Set or rotate the mail transport', then restart control and deploy again",
		)
		// The operator step is the composition's: on Cloudflare the GitHub Environment and the platform workflow.
		expect(() =>
			installationMailEnvironment(
				{ ...INVALID, remedy: CLOUDFLARE_MAIL_REMEDY },
				artifact({ 'job:digest': { ...REACH, mailer: 'installation' } }),
				'0.8.1',
			)
		)
			.toThrow(
				"FABRIKA_EMAIL_RESEND_API_KEY is missing; correct FABRIKA_EMAIL_* in the installation's GitHub Environment (re-run `fabrika platform init --provider=cloudflare` with the transport), re-run its platform workflow so Control's Worker holds the set, then deploy again",
			)
		const both = artifact({ 'job:b': { ...REACH, mailer: 'installation' }, 'job:a': { ...REACH, mailer: 'installation' } })
		expect(() => installationMailEnvironment(INVALID, both, '0.8.1')).toThrow("the contract's jobs `a`, `b` send mail through the installation")
	})
})

describe('a provider newer than the application', () => {
	const needs = artifact({ 'job:digest': { ...REACH, mailer: 'installation' } })
	const variables = {
		FABRIKA_EMAIL_PROVIDER: 'postmark',
		FABRIKA_EMAIL_FROM: 'mail@example.test',
		FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN: 'pm-private-token',
	}
	const postmark: InstallationMail = { kind: 'transport', transport: { variables, secretNames: new Set(['FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN']) } }

	test('is refused for a release that lacks it, naming the provider, the pin and the release it needs, never a value', () => {
		const refusal = (): unknown => installationMailEnvironment(postmark, needs, '0.8.1')
		expect(refusal).toThrow(
			"the contract's job `digest` sends mail through the installation (mailer: 'installation'), and the installation's provider `postmark` is unknown to framework 0.8.1, which this version pins: it needs 0.8.2 or newer. Raise the application's @fabrika/* pin, or choose another provider for the installation",
		)
		expect(refusal).not.toThrow('pm-private-token')
		expect(() => installationMailEnvironment(postmark, needs, undefined)).toThrow('unknown to the framework release this version was read with')
	})

	test('is handed to a release that holds it, and asks nothing of a contract without the job', () => {
		expect(installationMailEnvironment(postmark, needs, '0.8.2')).toEqual(variables)
		expect(installationMailEnvironment(postmark, needs, '0.9.0')).toEqual(variables)
		expect(installationMailEnvironment(postmark, artifact({}), '0.4.0')).toEqual({})
	})

	test('the providers every release holds, and one only a local composition registers, are never refused', () => {
		expect(installationMailEnvironment(TRANSPORT, needs, undefined)).toEqual(VARIABLES)
		expect(installationMailEnvironment(TRANSPORT, needs, '0.5.0')).toEqual(VARIABLES)
		const directory: InstallationMail = { kind: 'transport', transport: { variables: { FABRIKA_EMAIL_PROVIDER: 'directory' }, secretNames: new Set() } }
		expect(installationMailEnvironment(directory, needs, '0.5.0')).toEqual({ FABRIKA_EMAIL_PROVIDER: 'directory' })
	})

	test('Cloudflare is handed from framework 0.9 on, and refused to an older release', () => {
		const cloudflareVariables = {
			FABRIKA_EMAIL_PROVIDER: 'cloudflare',
			FABRIKA_EMAIL_FROM: 'mail@example.test',
			FABRIKA_EMAIL_CLOUDFLARE_API_TOKEN: 'cf-private-token',
			FABRIKA_EMAIL_CLOUDFLARE_ACCOUNT_ID: '023e105f4ecef8ad9ca31a8372d0c353',
		}
		const cloudflare: InstallationMail = {
			kind: 'transport',
			transport: { variables: cloudflareVariables, secretNames: new Set(['FABRIKA_EMAIL_CLOUDFLARE_API_TOKEN']) },
		}
		for (const framework of ['0.9.0', '0.9.0-cloudflare.1', '0.9.1', '1.0.0']) {
			expect(installationMailEnvironment(cloudflare, needs, framework)).toEqual(cloudflareVariables)
		}
		const refusal = (): unknown => installationMailEnvironment(cloudflare, needs, '0.8.2')
		expect(refusal).toThrow("the installation's provider `cloudflare` is unknown to framework 0.8.2, which this version pins: it needs 0.9.0 or newer")
		expect(refusal).not.toThrow('cf-private-token')
	})

	test('every built-in provider states its release', () => {
		expect(Object.keys(builtinEmailProviderSince).sort()).toEqual(Object.keys(builtinEmailProviders).sort())
	})
})

describe("the platform's relay for a job that sends through the installation", () => {
	const needs = artifact({ 'job:digest': { ...REACH, mailer: 'installation' } })

	test('a framework release from 0.7.0 on reads the relay; an older one, or a snapshot that records none, does not', () => {
		for (const framework of ['0.7.0', '0.7.3', '0.8.0', '1.0.0', '0.7.0-rc.1']) {
			expect(relaysInstallationMail(needs, framework)).toBe(true)
		}
		for (const framework of ['0.6.0', '0.6.3', '0.5.9', '0.4.8', undefined]) {
			expect(relaysInstallationMail(needs, framework)).toBe(false)
		}
	})

	test('only a contract with a job that sends through the installation needs it', () => {
		expect(relaysInstallationMail(artifact({ 'job:own': { ...REACH, mailer: 'own' } }), '0.7.0')).toBe(false)
		expect(relaysInstallationMail(null, '0.7.0')).toBe(false)
	})

	test("hands the relay's origin and the key, and nothing of a provider; a dry run's has no key", () => {
		expect(platformMailEnvironment('https://control.example.test', 'px_relay')).toEqual({
			FABRIKA_EMAIL_PROVIDER: 'platform',
			FABRIKA_PLATFORM_MAIL_URL: 'https://control.example.test',
			FABRIKA_PLATFORM_MAIL_KEY: 'px_relay',
		})
		expect(platformMailEnvironment('https://control.example.test', null)).toEqual({
			FABRIKA_EMAIL_PROVIDER: 'platform',
			FABRIKA_PLATFORM_MAIL_URL: 'https://control.example.test',
		})
	})

	test("the relay's origin is Control's public one, and without one the deploy is refused", () => {
		expect(platformMailOrigin('https://control.example.test')).toBe('https://control.example.test')
		expect(() => platformMailOrigin(undefined)).toThrow(
			'Control names no public origin for the application to reach it on (it needs FABRIKA_CONTROL_DOMAIN)',
		)
	})
})
