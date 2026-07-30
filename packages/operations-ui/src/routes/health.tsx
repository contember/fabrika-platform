import { createPage } from '@buzola/router'
import { PageHead, Unavailable } from '../components/Unavailable'

export default createPage()
	.route('/operations/health')
	.render(() => (
		<>
			<PageHead title="Health and telemetry" description="Runtime signals and delivery state for the observability pipeline." />
			<Unavailable>
				No health, metrics or telemetry-pipeline response is part of the Operations contract yet.
			</Unavailable>
		</>
	))
