import { CONTRACT_FORMAT, type ContractArtifact, type DeclaredReach } from '@fabrika/auth-core'
import { builtinEmailProviders } from '@fabrika/email/providers'
import { describe, expect, test } from 'bun:test'
import {
	type InstallationMail,
	installationMailEnvironment,
	installationMailJobs,
	installationMailSecrets,
	NO_INSTALLATION_MAIL,
	platformMailEnvironment,
	platformMailOrigin,
	readInstallationMail,
	relaysInstallationMail,
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
const INVALID: InstallationMail = { kind: 'invalid', reason: 'Email configuration is invalid: FABRIKA_EMAIL_RESEND_API_KEY is missing' }

describe('the installation mail transport', () => {
	test('none, or no provider at all, reads as none', () => {
		expect(readInstallationMail({}, builtinEmailProviders)).toEqual({ kind: 'none' })
		expect(readInstallationMail({ FABRIKA_EMAIL_PROVIDER: 'none', FABRIKA_EMAIL_FROM: 'mail@example.test' }, builtinEmailProviders)).toEqual({
			kind: 'none',
		})
	})

	test("a transport takes only the selected provider's variables, and names its secret ones", () => {
		const mail = readInstallationMail({
			FABRIKA_EMAIL_PROVIDER: 'smartemailing',
			FABRIKA_EMAIL_FROM: 'mail@example.test',
			FABRIKA_EMAIL_FROM_NAME: 'Notes',
			FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user@example.test',
			FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se-key',
			FABRIKA_EMAIL_RESEND_API_KEY: 'stale-resend-key',
			FABRIKA_EMAIL_SMARTEMAILING_TAG: '',
		}, builtinEmailProviders)
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
		const mail = readInstallationMail({ FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'private@example.test' }, builtinEmailProviders)
		expect(mail).toEqual({ kind: 'invalid', reason: expect.stringContaining('FABRIKA_EMAIL_RESEND_API_KEY is missing') })
		expect(JSON.stringify(mail)).not.toContain('private@example.test')
		expect(readInstallationMail({ FABRIKA_EMAIL_PROVIDER: 'smtp' }, builtinEmailProviders)).toEqual({
			kind: 'invalid',
			reason: expect.stringContaining('FABRIKA_EMAIL_PROVIDER must be none or one of'),
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
		expect(installationMailEnvironment(TRANSPORT, needs)).toEqual(VARIABLES)
		expect(installationMailSecrets(TRANSPORT, VARIABLES)).toEqual(['re_key'])
		expect(installationMailEnvironment(TRANSPORT, artifact({ 'job:own': { ...REACH, mailer: 'own' } }))).toEqual({})
		expect(installationMailEnvironment(NO_INSTALLATION_MAIL, null)).toEqual({})
		expect(installationMailEnvironment(INVALID, null)).toEqual({})
	})

	test('an installation without a transport hands the explicit none, so the application tells it from a missing variable', () => {
		const needs = artifact({ 'job:digest': { ...REACH, mailer: 'installation' } })
		expect(installationMailEnvironment(NO_INSTALLATION_MAIL, needs)).toEqual({ FABRIKA_EMAIL_PROVIDER: 'none' })
		expect(installationMailSecrets(NO_INSTALLATION_MAIL, { FABRIKA_EMAIL_PROVIDER: 'none' })).toEqual([])
	})

	test('an invalid transport refuses only a contract that needs it, naming each job and the operator step', () => {
		expect(() => installationMailEnvironment(INVALID, artifact({ 'job:digest': { ...REACH, mailer: 'installation' } }))).toThrow(
			"the contract's job `digest` sends mail through the installation (mailer: 'installation'), and Control's mail transport is invalid: Email configuration is invalid: FABRIKA_EMAIL_RESEND_API_KEY is missing; set FABRIKA_EMAIL_* on both iam and control: see `fabrika platform guide --provider=zerops`, 'Set or rotate the mail transport', then restart control and deploy again",
		)
		const both = artifact({ 'job:b': { ...REACH, mailer: 'installation' }, 'job:a': { ...REACH, mailer: 'installation' } })
		expect(() => installationMailEnvironment(INVALID, both)).toThrow("the contract's jobs `a`, `b` send mail through the installation")
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
