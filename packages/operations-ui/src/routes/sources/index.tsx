import { createPage } from '@buzola/router'
import { PageHead, Unavailable } from '../../components/Unavailable'

export default createPage()
	.route('/operations/sources')
	.render(() => (
		<>
			<PageHead title="Telemetry sources" description="Applications, environments and services known to Operations." />
			<Unavailable>
				The private catalog reconciliation contract exists. An operator-facing source list and opaque source identifiers do not exist yet.
			</Unavailable>
		</>
	))
