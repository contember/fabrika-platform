import { Link } from '@buzola/router'
import { CONTROL_ACTIONS, type RunDto } from '@fabrika/control-contract'
import { mayDo } from '../lib/console-access'
import { useConsoleAccess } from '../lib/console-caller'
import { fmtDuration } from '../lib/format'

/** A run list's duration cell: how long a finished run took, or what an unfinished one waits for, in words. */
export function RunDuration({ run }: { run: Pick<RunDto, 'id' | 'appId' | 'env' | 'status' | 'startedAt' | 'finishedAt'> }) {
	const access = useConsoleAccess()
	switch (run.status) {
		case 'awaiting_approval':
			return mayDo(access, CONTROL_ACTIONS.ACCESS_APPROVE, { app: run.appId, env: run.env })
				? (
					<Link to="approvals/detail" params={{ id: run.id }}>
						Review<span className="sr-only">{` the deploy of ${run.appId} / ${run.env}`}</span>
					</Link>
				)
				: 'Waits for approval'
		case 'pending':
			return 'Not started'
		case 'running':
			return 'Running'
		default:
			return fmtDuration(run.startedAt, run.finishedAt)
	}
}
