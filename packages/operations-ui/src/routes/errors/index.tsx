import { createPage } from '@buzola/router'
import { PageHead, Unavailable } from '../../components/Unavailable'

export default createPage()
	.route('/operations/errors')
	.render(() => (
		<>
			<PageHead title="Errors" description="Grouped failures ordered by recency and operator attention." />
			<Unavailable>
				The issue and event model is ready, but the public issue-query response is not part of the Operations contract yet.
			</Unavailable>
		</>
	))
