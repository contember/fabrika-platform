import { unhealthyTelemetry } from '../../lib/health'
import { deployHistory, OVERVIEW_ISSUE_LIMIT, OVERVIEW_RUN_LIMIT, type OverviewData } from '../../lib/overview'
import { Panel } from './Panel'

const dayLabel = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function Trends({ data }: { data: OverviewData }) {
	return (
		<Panel title="Over time" aside={<span className="ov-section-note">Completed deploys & received errors</span>}>
			<div className="ov-chart-pair">
				<DeployChart data={data} />
				<ErrorChart data={data} />
			</div>
		</Panel>
	)
}

function DeployChart({ data }: { data: OverviewData }) {
	if (data.runs.data === null) return <p className="ov-empty">Deploy history is unavailable.</p>
	const { days, limited } = deployHistory(data.runs.data, data.loadedAt)
	const total = days.reduce((sum, day) => sum + day.ok + day.failed, 0)
	const failed = days.reduce((sum, day) => sum + day.failed, 0)
	const peak = Math.max(1, ...days.map((day) => day.ok + day.failed))
	return (
		<div className="ov-chart">
			<div className="ov-chart-heading">
				<div>
					<span className="ov-eyebrow">Completed deploys · 14 days</span>
					<div className="ov-chart-number">
						{total}
						{limited ? '+' : ''}
						<span>
							{total > 0 ? `${Math.round((total - failed) / total * 100)}% succeeded${limited ? ' in sample' : ''}` : 'No completed deploys in sample'}
						</span>
					</div>
				</div>
				<div className="ov-legend">
					<span>
						<i className="ov-legend-ok" />Succeeded
					</span>
					<span>
						<i className="ov-legend-stop" />Failed
					</span>
				</div>
			</div>
			<div
				className="ov-bars"
				role="img"
				aria-label={`${total} completed deploys in the visible 14-day history, ${failed} failed${limited ? ', partial history' : ''}`}
			>
				{days.map((day) => (
					<div className="ov-bar-column" key={day.start} title={`${dayLabel(day.start)}: ${day.ok} succeeded, ${day.failed} failed`}>
						<div className="ov-bar-stack" style={{ height: `${(day.ok + day.failed) / peak * 100}%` }}>
							{day.failed > 0 && <span className="ov-bar-failed" style={{ flex: day.failed }} />}
							{day.ok > 0 && <span className="ov-bar-succeeded" style={{ flex: day.ok }} />}
						</div>
					</div>
				))}
			</div>
			<div className="ov-axis">
				<span>{dayLabel(days[0]?.start ?? data.loadedAt / 1000)}</span>
				<span>Today</span>
			</div>
			{limited && <span className="ov-chart-footnote">Partial history: the latest {OVERVIEW_RUN_LIMIT} runs, grouped by completion date.</span>}
		</div>
	)
}

function ErrorChart({ data }: { data: OverviewData }) {
	if (data.issues.data === null) return <p className="ov-empty">Error history is not readable.</p>
	// The existing API gives 12 two-hour buckets for open issues, not an all-error 14-day series.
	const values = Array.from({ length: 12 }, (_, index) => data.issues.data?.items.reduce((sum, issue) => sum + (issue.trend[index] ?? 0), 0) ?? 0)
	const total = values.reduce((sum, value) => sum + value, 0)
	const peak = Math.max(1, ...values)
	const points = values.map((value, index) => `${index * 480 / 11},${96 - value / peak * 88}`).join(' ')
	const limited = data.issues.data.nextCursor !== null
	const delayed = data.health.data === null || data.health.data.sources.some(unhealthyTelemetry)
	return (
		<div className="ov-chart">
			<div className="ov-chart-heading">
				<div>
					<span className="ov-eyebrow">Open-error occurrences · 24h</span>
					<div className="ov-chart-number">
						{total}
						{limited ? '+' : ''}
						<span>received events</span>
					</div>
				</div>
			</div>
			<div className="ov-line-chart">
				<svg
					viewBox="0 0 480 100"
					preserveAspectRatio="none"
					role="img"
					aria-label={`${total} received occurrences of the visible open errors in the last 24 hours`}
				>
					<polygon className="ov-chart-area" points={`0,100 ${points} 480,100`} />
					<polyline className="ov-chart-line" points={points} />
				</svg>
			</div>
			<div className="ov-axis">
				<span>24 hours ago</span>
				<span>Now</span>
			</div>
			<span className="ov-chart-footnote">
				{limited ? `Latest ${OVERVIEW_ISSUE_LIMIT} open errors only. ` : 'Open errors only. '}
				{delayed ? 'Telemetry is incomplete or not current.' : 'Resolved and ignored errors are excluded.'}
			</span>
		</div>
	)
}
