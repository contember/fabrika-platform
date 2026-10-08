import { createPage, Link } from '@buzola/router'
import { ApiError } from '../../../lib/api'
import { operationsClient } from '../../../operations/client'
import { ErrorDetailView } from '../../../operations/views/ErrorDetail'

export default createPage()
	.params({ issueId: 'string' })
	.loader(async ({ params }) => {
		const detail = await operationsClient.issue({ issueId: params.issueId })
		const [event, assignees, releases] = await Promise.all([
			operationsClient.latestEvent({ issueId: params.issueId }).catch((error) => {
				if (error instanceof ApiError && error.httpStatus === 404) return null
				throw error
			}),
			operationsClient.assignees({ sourceId: detail.issue.source.id }),
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
					initialEvent={data.event ?? null}
					assignees={data.assignees.items}
					releases={data.releases.items}
					onSelectOccurrence={(occurrenceId) => operationsClient.event({ issueId: issue.id, occurrenceId })}
					onLoadOccurrences={(cursor) => operationsClient.issueOccurrences({ issueId: issue.id, ...(cursor === undefined ? {} : { cursor }), limit: 50 })}
					onFindMergeTargets={async (query) => {
						const response = await operationsClient.issues({ sourceId: issue.source.id, query, sort: 'recent', limit: 25 })
						return response.items.filter((candidate) => candidate.id !== issue.id)
					}}
					onMutate={async (mutation) => {
						await operationsClient.mutateIssue({ issueId: issue.id, mutation })
						invalidate()
					}}
				/>
			</>
		)
	})
