import { createPage, Link } from '@buzola/router'
import { PageHead, Unavailable } from '../../components/Unavailable'

export default createPage()
	.params({ sourceId: 'string' })
	.route('/operations/sources/:sourceId/alerts')
	.render(() => (
		<>
			<Link to="operations/sources" className="back-link">← All sources</Link>
			<PageHead title="Alert rules" description="Notifications for new issues and regressions from one source." />
			<Unavailable>
				Alert kinds are defined, but destinations, rules and mutation responses do not have a public contract yet.
			</Unavailable>
		</>
	))
