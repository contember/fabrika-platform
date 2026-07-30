import { createPage, Link } from '@buzola/router'
import { OperationsApiError, operationsClient } from '../../client'
import { ErrorDetailView } from '../../views/ErrorDetail'

export default createPage()
	.params({ issueId: 'string' })
	.loader(async ({ params }) => {
		const detail = await operationsClient.issue(params.issueId)
		const [event, assignees, releases] = await Promise.all([
			operationsClient.latestEvent(params.issueId).catch((error) => {
				if (error instanceof OperationsApiError && error.status === 404) return null
				throw error
			}),
			operationsClient.assignees(detail.issue.source.id),
			operationsClient.releases({ sourceId: detail.issue.source.id, limit: 100 }),
		])
		return { detail, event, assignees, releases }
	})
	.route('/operations/errors/:issueId')
	.render(({ data, invalidate }) => {
		const issue = data.detail.issue
		return (
			<>
				<Link to="operations/errors" className="back-link">← All errors</Link>
				<ErrorDetailView
					issue={issue}
					event={data.event?.detail ?? null}
					assignees={data.assignees.items}
					releases={data.releases.items}
					onMutate={async (mutation) => {
						await operationsClient.mutateIssue(issue.id, mutation)
						invalidate()
					}}
				/>
			</>
		)
	})
