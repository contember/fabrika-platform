import { createPage, Link } from '@buzola/router'
import type { OperationsReleaseSummaryDto, OperationsSourceSummaryDto } from '@fabrika/operations-contract/operator-api'
import { useMemo, useState } from 'react'
import { QuerySearch } from '../../../components/QuerySearch'
import { fmtAgo, fmtDate } from '../../../lib/format'
import type { QueryFilters, QueryLanguage } from '../../../lib/query-search'
import { operationsClient } from '../../../operations/client'
import { PageHead } from '../../../operations/components/PageHead'
import { sourceIdNamed, sourceNames } from '../../../operations/views/Errors'

type ReleaseQueryKey = 'source' | 'state'

/**
 * The list filters in the browser, by source and by the states its releases are in; there is no text search. A source
 * is written as on the error list (`sourceNames`); one a release carries but the source list does not is written by
 * its id.
 */
function releaseQueryLanguage(
	sources: readonly OperationsSourceSummaryDto[],
	releases: readonly OperationsReleaseSummaryDto[],
): QueryLanguage<ReleaseQueryKey> {
	const listed = new Set(sources.map((source) => source.id))
	const unlisted = releases.map((release) => release.source.id).filter((id) => !listed.has(id))
	return {
		qualifiers: [
			{ key: 'source', name: 'source', values: [...new Set([...sourceNames(sources).values(), ...unlisted])] },
			{ key: 'state', name: 'state', values: [...new Set(releases.map((release) => release.state))] },
		],
		freeText: false,
	}
}

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
		const [filters, setFilters] = useState<QueryFilters<ReleaseQueryKey>>({})
		const language = useMemo(() => releaseQueryLanguage(data.sources.items, data.releases.items), [data.sources.items, data.releases.items])
		const visible = useMemo(() => {
			const sourceId = filters.source === undefined ? undefined : sourceIdNamed(data.sources.items, filters.source)
			return data.releases.items.filter((release) =>
				(sourceId === undefined || release.source.id === sourceId) && (filters.state === undefined || release.state === filters.state)
			)
		}, [data.releases.items, data.sources.items, filters])
		return (
			<>
				<PageHead title="Releases" description="Deploy markers correlated with new failures and regressions." />
				<QuerySearch
					id="release-search"
					language={language}
					label="Search"
					filters={filters}
					onApply={(next) => setFilters(next)}
					placeholder="source:notes state:failed"
					live
					aside={`${visible.length} ${visible.length === 1 ? 'release' : 'releases'}`}
				/>
				<div className="table-wrap">
					<table aria-label="Operations releases">
						<thead>
							<tr>
								<th>State</th>
								<th className="grow">Release</th>
								<th>Source</th>
								<th>Commit</th>
								<th className="numeric">New issues</th>
								<th className="numeric">Regressions</th>
								<th>Finished</th>
							</tr>
						</thead>
						<tbody>
							{visible.length === 0
								? (
									<tr>
										<td colSpan={7} className="empty">No release markers match.</td>
									</tr>
								)
								: visible.map((release) => (
									<tr key={release.id}>
										<td className="nowrap">
											<button
												type="button"
												className="filter-value"
												title="Filter to this state"
												onClick={() => setFilters({ ...filters, state: release.state })}
											>
												<span className={`status status-${release.state === 'succeeded' ? 'ok' : release.state === 'failed' ? 'stop' : 'idle'}`}>
													<span className="lamp" aria-hidden="true" />
													{release.state}
												</span>
											</button>
										</td>
										{
											/* The name is the release's full identifier, its commit included, so it keeps to one line here and
										    reads in full on hover and on its page; the commit has a column of its own. */
										}
										<td className="release-cell">
											<Link to="operations/releases/detail" params={{ releaseId: release.id }} title={release.releaseName}>
												<code className="release-name">{release.releaseName}</code>
											</Link>
											<div className="cell-note">artifact {release.artifactState}</div>
										</td>
										<td className="nowrap">
											<button
												type="button"
												className="filter-value"
												title="Filter to this source"
												onClick={() => setFilters({ ...filters, source: sourceNames(data.sources.items).get(release.source.id) ?? release.source.id })}
											>
												<span>{release.source.displayName}</span>
											</button>
										</td>
										<td>
											<code>{release.commitSha.slice(0, 10)}</code>
										</td>
										<td className={release.newIssueCount === 0 ? 'numeric muted' : 'numeric'}>{release.newIssueCount}</td>
										<td className={release.regressionCount === 0 ? 'numeric muted' : 'numeric'}>{release.regressionCount}</td>
										<td className="muted small nowrap" title={fmtDate(release.finishedAt === null ? null : release.finishedAt / 1000)}>
											{release.finishedAt === null ? 'not finished' : fmtAgo(release.finishedAt / 1000)}
										</td>
									</tr>
								))}
						</tbody>
					</table>
				</div>
			</>
		)
	})
