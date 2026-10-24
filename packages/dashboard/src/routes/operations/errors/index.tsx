import { createPage } from '@buzola/router'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import { mayDo } from '../../../lib/console-access'
import { consoleSession } from '../../../lib/session'
import { operationsClient } from '../../../operations/client'
import { PageHead } from '../../../operations/components/PageHead'
import { ErrorsView, issueFiltersFromQuery, issueQuery } from '../../../operations/views/Errors'

export default createPage()
	.params({ window: '?string', source: '?string' })
	.loader(async ({ params }) => {
		const filters = issueFiltersFromQuery(
			{ status: 'open', window: params.window ?? '24h', ...(params.source ? { source: params.source } : {}) },
			'',
			[],
		)
		const [issues, sources, { access }] = await Promise.all([
			operationsClient.issues(issueQuery(filters)),
			operationsClient.sources(),
			consoleSession(),
		])
		return { issues, filters, sources: sources.items, triages: mayDo(access, OPERATIONS_ACTIONS.TRIAGE) }
	})
	.route('/operations/errors')
	.render(({ data, invalidate }) => (
		<>
			<PageHead title="Errors" description="Grouped failures ordered by recency and operator attention." />
			<ErrorsView
				key={`${data.filters.sourceId}:${data.filters.window}`}
				initialPage={data.issues}
				initialFilters={data.filters}
				sources={data.sources}
				onQuery={(query) => operationsClient.issues(query)}
				{...(data.triages
					? {
						onMutate: async (issueId, mutation) => {
							await operationsClient.mutateIssue({ issueId, mutation })
							invalidate()
						},
						onBulkStatus: async (issueIds, status) => {
							await operationsClient.bulkIssueStatus({ issueIds, status })
							invalidate()
						},
						onBulkMerge: async (issueIds, targetIssueId) => {
							for (const issueId of issueIds) {
								if (issueId !== targetIssueId) await operationsClient.mutateIssue({ issueId, mutation: { kind: 'merge', targetIssueId } })
							}
							invalidate()
						},
					}
					: {})}
			/>
		</>
	))
