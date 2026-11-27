import { Link } from '@buzola/router'
import { effectCounts } from '../lib/access-changes'
import type { ApprovalPlanDto } from '../lib/api'
import { activeEntries, PLAN_STATE_TEXT, planLamp, planLines } from '../lib/approval-plans'
import { fmtDate, shortSha } from '../lib/format'
import { Chip, Status } from './Status'
import { Table } from './Table'

/**
 * Plans beside the parked deploys (ADR-0050 §5): the ones that wait for a decision, and the approved ones that still
 * cover a deploy, so a person finds them to revoke. What each approves, where, who asked and until when.
 */
export function ApprovalPlansSection({ plans }: { plans: readonly ApprovalPlanDto[] }) {
	return (
		<section>
			<h2>Plans</h2>
			<p className="hint">
				The access change of a commit not deployed yet, approved ahead: a deploy whose lines an approved plan shows publishes without waiting.
			</p>
			<Table
				colSpan={6}
				isEmpty={false}
				head={
					<tr>
						<th>Status</th>
						<th>App</th>
						<th>Env</th>
						<th className="grow">Plan</th>
						<th>Asked by</th>
						<th>Until</th>
					</tr>
				}
			>
				{plans.map((plan) => <PlanRow key={plan.id} plan={plan} />)}
			</Table>
		</section>
	)
}

function PlanRow({ plan }: { plan: ApprovalPlanDto }) {
	const { covered } = planLines(plan)
	const subjects = `${covered.length} ${covered.length === 1 ? 'subject' : 'subjects'}`
	const until = plan.state === 'approved' ? plan.expiresAt : plan.deadline
	return (
		<tr>
			<td>
				<Link to="approvals/plans/detail" params={{ id: plan.id }}>
					<Status lamp={planLamp(plan.state)}>{PLAN_STATE_TEXT[plan.state]}</Status>
				</Link>
			</td>
			<td>
				<Link to="apps/detail" params={{ id: plan.appId }}>{plan.appId}</Link>
			</td>
			<td>
				<Chip>{plan.env}</Chip>
			</td>
			<td>
				<Link to="approvals/plans/detail" params={{ id: plan.id }}>
					Commit <code>{shortSha(plan.commitSha)}</code>
				</Link>
				<div className="small muted">
					{plan.state === 'approved' ? `${activeEntries(plan)} of ${plan.entries.length} entries cover a deploy` : subjects} ·{' '}
					{effectCounts(plan.lines.map((line) => line.change))}
				</div>
			</td>
			<td className="small nowrap">{plan.requester.principal.label}</td>
			<td className="muted small nowrap">{until === undefined ? '—' : fmtDate(until)}</td>
		</tr>
	)
}
