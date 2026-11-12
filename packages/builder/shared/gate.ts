/** The id of the verdict question every gate view ends with, and its two answers. */
export const GATE_VERDICT_ID = 'verdict'
export const GATE_APPROVE = 'Approve'
export const GATE_CHANGES = 'Request changes'

/** `none` is a submission whose verdict question was left unanswered (or a view without one). */
export type GateVerdict = 'approve' | 'changes' | 'none'

export interface GateAnswer {
	id: string
	value: string | string[] | number
}

export function gateVerdict(answers: readonly GateAnswer[]): GateVerdict {
	const answer = answers.find((a) => a.id === GATE_VERDICT_ID)
	if (answer === undefined) return 'none'
	if (answer.value === GATE_APPROVE) return 'approve'
	if (answer.value === GATE_CHANGES) return 'changes'
	return 'none'
}
