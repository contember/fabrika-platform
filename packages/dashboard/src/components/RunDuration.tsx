import { Link } from '@buzola/router'
import { CONTROL_ACTIONS, type RunDto } from '@fabrika/control-contract'
import { mayDo } from '../lib/console-access'
import { useConsoleAccess } from '../lib/console-caller'
import { fmtDuration } from '../lib/format'

type ListedRun = Pick<RunDto, 'id' | 'appId' | 'env' | 'status' | 'startedAt' | 'finishedAt'>

/** A run list's duration cell: how long a finished run took, or in words why there is no duration yet. */
export function RunDuration({ run }: { run: ListedRun }) {
	switch (run.status) {
		case 'awaiting_approval':
			return 'Waiting'
		case 'pending':
			return 'Not started'
		case 'running':
			return 'Running'
		default:
			// A run refused before it started (a missing secret, a refused contract) has no duration.
			return run.startedAt === null ? 'Did not start' : fmtDuration(run.startedAt, run.finishedAt)
	}
}

/** Beside a waiting run's status in a run list: its review, for someone who may decide it there. */
export function RunReview({ run }: { run: ListedRun }) {
	const access = useConsoleAccess()
	if (run.status !== 'awaiting_approval' || !mayDo(access, CONTROL_ACTIONS.ACCESS_APPROVE, { app: run.appId, env: run.env })) return null
	return (
		<>
			{' · '}
			<Link to="approvals/detail" params={{ id: run.id }}>
				Review<span className="sr-only">{` the deploy of ${run.appId} / ${run.env}`}</span>
			</Link>
		</>
	)
}
