import { createPage } from '@buzola/router'
import { operationsClient } from '../../client'
import { PageHead } from '../../components/Unavailable'
import { ErrorsView } from '../../views/Errors'

export default createPage()
	.loader(async () => ({ issues: await operationsClient.issues({ limit: 100 }) }))
	.route('/operations/errors')
	.render(({ data, invalidate }) => (
		<>
			<PageHead title="Errors" description="Grouped failures ordered by recency and operator attention." />
			<ErrorsView
				issues={data.issues.items}
				onMutate={async (issueId, mutation) => {
					await operationsClient.mutateIssue(issueId, mutation)
					invalidate()
				}}
				onBulkStatus={async (issueIds, status) => {
					await operationsClient.bulkIssueStatus({ issueIds, status })
					invalidate()
				}}
			/>
		</>
	))
