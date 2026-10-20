// The access diff as the tests of its words read it: each line's effect, words and marks, without the facts the line
// carries beside them (rule, subject, audience, reason, consequence), which `approval-facts.test.ts` covers.

import type { AccessChangeDto } from '@fabrika/control-contract'
import { type AccessOutcome, classifyAccess as classifyWithFacts } from '../../approval/diff'
import type { AccessSnapshot } from '../../approval/snapshot'

export interface WordedChange {
	readonly effect: AccessChangeDto['effect']
	readonly line: string
	readonly review?: 'closer'
	readonly environmentOrigins?: true
}

export function wordsOf(changes: readonly AccessChangeDto[]): WordedChange[] {
	return changes.map(({ effect, line, review, environmentOrigins }) => ({
		effect,
		line,
		...(review === undefined ? {} : { review }),
		...(environmentOrigins === undefined ? {} : { environmentOrigins }),
	}))
}

export function classifyAccess(baseline: AccessSnapshot, candidate: AccessSnapshot): { outcome: AccessOutcome; changes: WordedChange[] } {
	const { outcome, changes } = classifyWithFacts(baseline, candidate)
	return { outcome, changes: wordsOf(changes) }
}
