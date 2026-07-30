import { createPage, Link } from '@buzola/router'
import { PageHead, Unavailable } from '../../components/Unavailable'

export default createPage()
	.params({ issueId: 'string' })
	.route('/operations/errors/:issueId')
	.render(() => (
		<>
			<Link to="operations/errors" className="back-link">← All errors</Link>
			<PageHead title="Error detail" description="Occurrence context, stack trace and triage history." />
			<Unavailable>
				This route keeps the issue identifier opaque. It will load detail after the public issue-detail response is versioned.
			</Unavailable>
		</>
	))
