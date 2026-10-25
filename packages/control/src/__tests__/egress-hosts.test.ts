// The installation's own hosts, which Control hands a deploy whose approved contract has a cron job with
// `egress: 'public'` (ADR-0071): Control's, IAM's, Operations' and every environment's domain and public origin.

import type { ContractArtifact, DeclaredReach } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { declaresPublicEgress, installationHosts } from '../egress-hosts'

const reach: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }

describe('declaresPublicEgress', () => {
	test("holds for a contract with a job that declares egress: 'public', and for no other", () => {
		const declared = (egress: DeclaredReach['egress']): ContractArtifact => ({
			...notesArtifact,
			declared: { 'job:crawl': egress === undefined ? reach : { ...reach, egress } },
		})
		expect(declaresPublicEgress(declared('public'))).toBe(true)
		expect(declaresPublicEgress(declared(['https://api.example.com']))).toBe(false)
		expect(declaresPublicEgress(declared(undefined))).toBe(false)
		expect(declaresPublicEgress(notesArtifact)).toBe(false)
		expect(declaresPublicEgress(null)).toBe(false)
	})
})

describe('installationHosts', () => {
	test('collects the hosts of the given origins and of every environment, normalized, sorted and once', () => {
		expect(
			installationHosts(['https://control.acme.cz', 'https://IAM.acme.cz/', undefined, 'not a url', 'https://ops.acme.cz:8443'], [
				{ domain: 'notes.acme.cz', public_origin: 'https://notes.acme.cz' },
				{ domain: 'CRM.acme.cz.', public_origin: 'https://www.crm-client.com' },
				{ domain: null, public_origin: null },
			]),
		).toBe('control.acme.cz,crm.acme.cz,iam.acme.cz,notes.acme.cz,ops.acme.cz,www.crm-client.com')
	})

	test('is empty when it knows no host', () => {
		expect(installationHosts([undefined], [])).toBe('')
	})
})
