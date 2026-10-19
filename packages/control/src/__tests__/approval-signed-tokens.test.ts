// Signed tokens in the conservative access diff (ADR-0050): a new token purpose and a site that starts signing one widen,
// a longer lifetime widens, and a dropped purpose or `signs` narrows.

import type { ContractArtifact, DeclaredReach, TokenPurposeArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const reach: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }
const UNSUBSCRIBE: TokenPurposeArtifact = { claims: { type: 'object', fields: { email: { type: 'boolean' } } }, maxDays: 400 }

function snapshot(tokens: Readonly<Record<string, TokenPurposeArtifact>> | null, signs: readonly string[] = []): AccessSnapshot {
	const contract: ContractArtifact = {
		...notesArtifact,
		declared: signs.length === 0 ? {} : { 'job:mailing': { ...reach, signs } },
		...(tokens === null ? {} : { tokens }),
	}
	return { version: 1, contract, migrations: [], checker: '0.0.0' }
}

describe('signed tokens in the approval diff', () => {
	test('a new purpose and a job that signs it widen', () => {
		expect(classifyAccess(snapshot(null), snapshot({ unsubscribe: UNSUBSCRIBE }, ['unsubscribe']))).toEqual({
			outcome: 'widening',
			changes: [
				{ effect: 'widens', line: 'New token purpose `unsubscribe`, a token of it valid up to 400 days' },
				{ effect: 'widens', line: 'Job `mailing` signs `unsubscribe` tokens' },
			],
		})
	})

	test('a longer lifetime widens, a shorter one and a dropped signs narrow', () => {
		const longer = { unsubscribe: { ...UNSUBSCRIBE, maxDays: 500 } }
		expect(classifyAccess(snapshot({ unsubscribe: UNSUBSCRIBE }, ['unsubscribe']), snapshot(longer, ['unsubscribe'])).changes).toEqual([
			{ effect: 'widens', line: 'Token purpose `unsubscribe` lifetime changes from 400 to 500 days' },
		])
		expect(classifyAccess(snapshot(longer, ['unsubscribe']), snapshot({ unsubscribe: UNSUBSCRIBE })).changes).toEqual([
			{ effect: 'narrows', line: 'Token purpose `unsubscribe` lifetime changes from 500 to 400 days' },
			{ effect: 'narrows', line: 'Job `mailing` no longer signs `unsubscribe` tokens' },
		])
	})
})
