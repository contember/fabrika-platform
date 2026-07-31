import { createPage, Link } from '@buzola/router'
import { useMemo, useState } from 'react'
import { operationsClient } from '../client'
import { PageHead } from '../components/Unavailable'
import { formatTimestamp } from '../format'

export default createPage()
	.loader(async () => {
		const [releases, sources] = await Promise.all([
			operationsClient.releases({ limit: 100 }),
			operationsClient.sources(),
		])
		return { releases, sources }
	})
	.route('/operations/releases')
	.render(({ data }) => {
		const [sourceId, setSourceId] = useState('')
		const visible = useMemo(
			() => sourceId === '' ? data.releases.items : data.releases.items.filter((release) => release.source.id === sourceId),
			[data.releases.items, sourceId],
		)
		return (
			<>
				<PageHead title="Releases" description="Deploy markers correlated with new failures and regressions." />
				<div className="filters">
					<label>
						Source
						<select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
							<option value="">All sources</option>
							{data.sources.items.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}
						</select>
					</label>
					<span className="count">{visible.length} releases</span>
				</div>
				<div className="table-wrap">
					<table aria-label="Operations releases">
						<thead>
							<tr>
								<th>State</th>
								<th className="grow">Release</th>
								<th>Source</th>
								<th>Commit</th>
								<th>New issues</th>
								<th>Regressions</th>
								<th>Finished</th>
							</tr>
						</thead>
						<tbody>
							{visible.length === 0
								? (
									<tr>
										<td colSpan={7} className="empty">No release markers match this source.</td>
									</tr>
								)
								: visible.map((release) => (
									<tr key={release.id}>
										<td>
											<span className={`status status-${release.state === 'succeeded' ? 'ok' : release.state === 'failed' ? 'stop' : 'idle'}`}>
												<span className="lamp" aria-hidden="true" />
												{release.state}
											</span>
										</td>
										<td>
											<Link to="operations/releases/detail" params={{ releaseId: release.id }}>
												<strong>{release.releaseName}</strong>
											</Link>
											<div className="cell-note">artifact {release.artifactState}</div>
										</td>
										<td>{release.source.displayName}</td>
										<td>
											<code>{release.commitSha.slice(0, 10)}</code>
										</td>
										<td className="numeric">{release.newIssueCount}</td>
										<td className="numeric">{release.regressionCount}</td>
										<td>{formatTimestamp(release.finishedAt)}</td>
									</tr>
								))}
						</tbody>
					</table>
				</div>
			</>
		)
	})
