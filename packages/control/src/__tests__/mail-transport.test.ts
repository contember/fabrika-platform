import type { ContractArtifact, DeclaredReach } from '@fabrika/auth-core'
import { builtinEmailProviders } from '@fabrika/email/providers'
import { describe, expect, test } from 'bun:test'
import { installationMailEnvironment, installationMailJobs, type InstallationMailTransport, readInstallationMailTransport } from '../mail-transport'

const REACH: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }

/** An artifact whose only interesting part is the reach its sites declare. */
const artifact = (declared: Record<string, DeclaredReach>): ContractArtifact => ({
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

const TRANSPORT: InstallationMailTransport = {
	variables: { FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'mail@example.test', FABRIKA_EMAIL_RESEND_API_KEY: 're_key' },
	secretNames: new Set(['FABRIKA_EMAIL_RESEND_API_KEY']),
}

describe('the installation mail transport', () => {
	test('none, or no provider at all, reads as null', () => {
		expect(readInstallationMailTransport({}, builtinEmailProviders)).toBeNull()
		expect(readInstallationMailTransport({ FABRIKA_EMAIL_PROVIDER: 'none', FABRIKA_EMAIL_FROM: 'mail@example.test' }, builtinEmailProviders)).toBeNull()
	})

	test("a transport takes only the selected provider's variables, and names its secret ones", () => {
		const transport = readInstallationMailTransport({
			FABRIKA_EMAIL_PROVIDER: 'smartemailing',
			FABRIKA_EMAIL_FROM: 'mail@example.test',
			FABRIKA_EMAIL_FROM_NAME: 'Notes',
			FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user@example.test',
			FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se-key',
			FABRIKA_EMAIL_RESEND_API_KEY: 'stale-resend-key',
			FABRIKA_EMAIL_SMARTEMAILING_TAG: '',
		}, builtinEmailProviders)
		expect(transport?.variables).toEqual({
			FABRIKA_EMAIL_PROVIDER: 'smartemailing',
			FABRIKA_EMAIL_FROM: 'mail@example.test',
			FABRIKA_EMAIL_FROM_NAME: 'Notes',
			FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user@example.test',
			FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se-key',
		})
		expect([...(transport?.secretNames ?? [])].sort()).toEqual(['FABRIKA_EMAIL_SMARTEMAILING_API_KEY', 'FABRIKA_EMAIL_SMARTEMAILING_USERNAME'])
	})

	test('an invalid transport is refused by variable name', () => {
		expect(() => readInstallationMailTransport({ FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'mail@example.test' }, builtinEmailProviders))
			.toThrow('FABRIKA_EMAIL_RESEND_API_KEY is missing')
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

	test('a deploy hands the transport only when a job needs it', () => {
		const needs = artifact({ 'job:digest': { ...REACH, mailer: 'installation' } })
		expect(installationMailEnvironment(TRANSPORT, needs)).toEqual(TRANSPORT.variables)
		expect(installationMailEnvironment(TRANSPORT, artifact({ 'job:own': { ...REACH, mailer: 'own' } }))).toEqual({})
		expect(installationMailEnvironment(undefined, null)).toEqual({})
	})

	test('a job that needs it is refused where the installation has none, naming each job', () => {
		expect(() => installationMailEnvironment(undefined, artifact({ 'job:digest': { ...REACH, mailer: 'installation' } }))).toThrow(
			"the contract's job `digest` sends mail through the installation (mailer: 'installation'), and this installation cannot hand it a mail transport (Control needs FABRIKA_EMAIL_PROVIDER, FABRIKA_EMAIL_FROM and the provider's variables)",
		)
		const both = artifact({ 'job:b': { ...REACH, mailer: 'installation' }, 'job:a': { ...REACH, mailer: 'installation' } })
		expect(() => installationMailEnvironment(undefined, both)).toThrow(
			"the contract's jobs `a`, `b` send mail through the installation (mailer: 'installation'), and this installation cannot hand them a mail transport (Control needs FABRIKA_EMAIL_PROVIDER, FABRIKA_EMAIL_FROM and the provider's variables)",
		)
	})
})
