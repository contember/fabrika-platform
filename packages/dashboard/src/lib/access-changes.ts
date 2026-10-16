// The three effects of an access change line (ADR-0050 §3), in the order the console shows them, and how the list and
// the approval page name each one.

import type { AccessChangeDto } from '@fabrika/control-contract'

export type AccessEffect = AccessChangeDto['effect']

export interface EffectSection {
	readonly effect: AccessEffect
	/** The approval page's section heading. */
	readonly title: string
	/** The approvals list's count word: `2 widening`. */
	readonly count: string
	readonly icon: 'alert' | 'check' | 'arrow-right'
	readonly hint?: string
}

export const EFFECT_SECTIONS: readonly EffectSection[] = [
	{ effect: 'widens', title: 'Widens access', count: 'widening', icon: 'alert' },
	{ effect: 'narrows', title: 'Narrows access', count: 'narrowing', icon: 'check' },
	{
		effect: 'neutral',
		title: 'Access unchanged',
		count: 'unchanged',
		icon: 'arrow-right',
		hint: 'These lines admit no one new and take nothing away, for example a path another endpoint now answers for the same callers.',
	},
]

export function changesWith(changes: readonly AccessChangeDto[], effect: AccessEffect): AccessChangeDto[] {
	return changes.filter((change) => change.effect === effect)
}

/** `2 widening, 1 narrowing, 1 unchanged`, leaving out an effect no line has. */
export function effectCounts(changes: readonly AccessChangeDto[]): string {
	return EFFECT_SECTIONS
		.map((section) => ({ count: changesWith(changes, section.effect).length, word: section.count }))
		.filter(({ count }) => count > 0)
		.map(({ count, word }) => `${count} ${word}`)
		.join(', ')
}
