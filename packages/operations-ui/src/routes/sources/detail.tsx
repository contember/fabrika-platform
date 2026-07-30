import { createPage, Link } from '@buzola/router'
import { PageHead, Unavailable } from '../../components/Unavailable'

export default createPage()
	.params({ sourceId: 'string' })
	.route('/operations/sources/:sourceId')
	.render(() => (
		<>
			<Link to="operations/sources" className="back-link">← All sources</Link>
			<PageHead title="Source settings" description="Ingest configuration and retention for one telemetry source." />
			<Unavailable>
				Source settings need a public source-detail contract before this page can read or change them.
			</Unavailable>
		</>
	))
