import { createPage } from '@buzola/router'
import { PageHead, Unavailable } from '../components/Unavailable'

export default createPage()
	.route('/operations/releases')
	.render(() => (
		<>
			<PageHead title="Releases" description="Deploy markers correlated with new failures and regressions." />
			<Unavailable>
				Issue events can carry a release, but release ingestion and operator-query contracts are not defined yet.
			</Unavailable>
		</>
	))
