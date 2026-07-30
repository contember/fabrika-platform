import { createPage, Link } from '@buzola/router'
import { operationsClient } from '../../client'
import { formatTimestamp } from '../../format'

export default createPage()
	.params({ releaseId: 'string' })
	.loader(async ({ params }) => ({ detail: await operationsClient.release(params.releaseId) }))
	.route('/operations/releases/:releaseId')
	.render(({ data }) => (
		<>
			<Link to="operations/releases" className="back-link">← All releases</Link>
			<div className="page-head">
				<p className="eyebrow">{data.detail.release.source.displayName}</p>
				<div className="page-head-row">
					<div>
						<h1>{data.detail.release.releaseName}</h1>
						<p className="hint">Run {data.detail.release.runId} · commit {data.detail.release.commitSha}</p>
					</div>
					<span
						className={`status status-${data.detail.release.state === 'succeeded' ? 'ok' : data.detail.release.state === 'failed' ? 'stop' : 'idle'}`}
					>
						<span className="lamp" aria-hidden="true" />
						{data.detail.release.state}
					</span>
				</div>
			</div>
			<div className="detail-grid">
				<Fact label="Artifact" value={data.detail.release.artifactState} />
				<Fact label="Created" value={formatTimestamp(data.detail.release.createdAt)} />
				<Fact label="Finished" value={formatTimestamp(data.detail.release.finishedAt)} />
				<Fact label="New issues" value={String(data.detail.release.newIssueCount)} />
				<Fact label="Regressions" value={String(data.detail.release.regressionCount)} />
			</div>
			<section>
				<div className="section-head">
					<h2>Correlated issues</h2>
				</div>
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Level</th>
								<th className="grow">Issue</th>
								<th>Status</th>
								<th>Events</th>
							</tr>
						</thead>
						<tbody>
							{data.detail.issues.length === 0
								? (
									<tr>
										<td colSpan={4} className="empty">No issues are correlated with this release.</td>
									</tr>
								)
								: data.detail.issues.map((issue) => (
									<tr key={issue.id}>
										<td>{issue.level}</td>
										<td>
											<Link to="operations/errors/detail" params={{ issueId: issue.id }}>{issue.title}</Link>
											{issue.culprit !== null && <div className="cell-note">{issue.culprit}</div>}
										</td>
										<td>{issue.status}</td>
										<td className="numeric">{issue.count}</td>
									</tr>
								))}
						</tbody>
					</table>
				</div>
			</section>
		</>
	))

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	)
}
