import { createPage } from '@buzola/router'
import { operationsClient } from '../../../operations/client'
import { PageHead } from '../../../operations/components/PageHead'
import { ErrorsView } from '../../../operations/views/Errors'

export default createPage()
	.loader(async () => {
		const [issues, sources] = await Promise.all([
			operationsClient.issues({ status: 'open', window: '24h', assignee: 'all', sort: 'recent', limit: 50 }),
			operationsClient.sources(),
		])
		return { issues, sources: sources.items }
	})
	.route('/operations/errors')
	.render(({ data, invalidate }) => (
		<>
			<PageHead title="Errors" description="Grouped failures ordered by recency and operator attention." />
			<ErrorsView
				initialPage={data.issues}
				sources={data.sources}
				onQuery={(query) => operationsClient.issues(query)}
				onMutate={async (issueId, mutation) => {
					await operationsClient.mutateIssue({ issueId, mutation })
					invalidate()
				}}
				onBulkStatus={async (issueIds, status) => {
					await operationsClient.bulkIssueStatus({ issueIds, status })
					invalidate()
				}}
				onBulkMerge={async (issueIds, targetIssueId) => {
					for (const issueId of issueIds) {
						if (issueId !== targetIssueId) await operationsClient.mutateIssue({ issueId, mutation: { kind: 'merge', targetIssueId } })
					}
					invalidate()
				}}
			/>
		</>
	))
