// A run's stored approval stays readable across releases: a field a later release adds is dropped, the digests bind it.

import { describe, expect, test } from 'bun:test'
import { parseApproval } from '../approval/publish'

const digest = (char: string) => `sha256:${char.repeat(64)}`

describe('a stored run approval', () => {
	test('reads one a later release wrote with more fields, keeping what binds it', () => {
		const raw = JSON.stringify({
			principalId: 'user-1',
			label: 'Ada',
			approvedAt: 1_700_000_000,
			candidateDigest: digest('a'),
			baselineDigest: digest('b'),
			stepUp: { credentialId: 'cred-1', at: 1_700_000_000, attestation: 'later' },
			reviewNote: 'a field this release does not know',
		})
		expect(parseApproval(raw)).toEqual({
			principalId: 'user-1',
			label: 'Ada',
			approvedAt: 1_700_000_000,
			candidateDigest: digest('a'),
			baselineDigest: digest('b'),
			stepUp: { credentialId: 'cred-1', at: 1_700_000_000 },
		})
	})

	test('still refuses one without the digests it approved', () => {
		expect(() => parseApproval(JSON.stringify({ principalId: 'user-1', label: 'Ada', approvedAt: 1 }))).toThrow()
	})
})
