// The three effects of an access change line (ADR-0050 §3), in the order the console shows them, and how the list and
// the approval page name each one; the approval page's group titles, its review reasons and where a decided run stands.

import type { AccessChangeDto, ApprovalDto, ChangeSubjectKind, SurfaceReach } from '@fabrika/control-contract'
import { type Lamp, runLamp } from '../components/Status'

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

/** Who a caller group's endpoints are reached by, as its heading says it. */
export function callerGroupTitle(reach: SurfaceReach, mount?: string): string {
	switch (reach) {
		case 'anyone':
			return 'Anyone, without signing in'
		case 'link':
			return mount === undefined ? 'Share links' : `Share links of \`${mount}\``
		case 'app':
			return 'Other applications'
		case 'machine':
			return 'Machines'
		case 'human':
			return 'Signed-in people'
	}
}

export const SUBJECT_TITLES: Record<ChangeSubjectKind, string> = {
	application: 'The application',
	endpoint: 'Endpoints',
	mount: 'Mounts',
	dimension: 'Dimensions',
	action: 'Actions',
	role: 'Roles',
	table: 'Tables',
	'file-collection': 'File collections',
	'file-kind': 'File kinds',
	job: 'Jobs',
	export: 'Exports',
	import: 'Imports',
	token: 'Token purposes',
	csp: 'Content security policy',
	migration: 'Migrations',
}

/**
 * Why a line needs closer review, one fixed sentence per reason (ADR-0050 §7). A line that starts a job when anyone
 * calls says which job anyone sets off.
 */
export function reviewReason(change: AccessChangeDto): string | null {
	if (change.review !== 'closer') return null
	switch (change.reason) {
		case 'off-road':
			return 'A step off the paved road: read the code behind it, not only this line.'
		case 'anyone-calls':
			return change.consequence === undefined
				? 'Anyone on the internet sets this off, without signing in.'
				: `Anyone on the internet decides when job \`${change.consequence.job}\` runs.`
		case 'get-mutation':
			return 'It changes state on a GET: a link scanner that opens the URL sets it off.'
		case 'people':
			return 'It shows who people are: who holds a role, or labels that spell their email addresses.'
		case 'adoption':
			return "It moves stored files under a table's policy, or deletes the ones no column took."
		case 'terminal':
			return "The application decides who is signed in on a shared computer, within the terminal's ceiling."
		case undefined:
			return null
	}
}

/** Where a decided run stands: approval and publication are two steps (ADR-0050 §2). */
export function approvalStage(approval: ApprovalDto): { readonly lamp: Lamp; readonly text: string } {
	const { run } = approval
	if (run.status === 'awaiting_approval') {
		return approval.approval?.holds === false
			? { lamp: 'stop', text: 'Approval lapsed: the environment published another change first, and this one still widens access against it' }
			: { lamp: 'run', text: 'Waiting for a decision' }
	}
	if (approval.approval === null) return { lamp: runLamp(run.status), text: run.status === 'failed' ? 'Refused or failed' : 'Decided' }
	switch (run.status) {
		case 'pending':
			return { lamp: 'idle', text: 'Approved, waiting to run' }
		case 'running':
			return { lamp: 'run', text: 'Approved, running' }
		case 'succeeded':
			return { lamp: 'ok', text: 'Approved and published' }
		case 'failed':
			return { lamp: 'stop', text: 'Approved, then failed' }
	}
}
