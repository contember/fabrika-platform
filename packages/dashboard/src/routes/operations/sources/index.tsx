import { createPage } from '@buzola/router'
import { operationsClient } from '../../../operations/client'
import { PageHead } from '../../../operations/components/PageHead'
import { SourcesView } from '../../../operations/views/Sources'

export default createPage()
	.loader(async () => ({ sources: await operationsClient.sources() }))
	.route('/operations/sources')
	.render(({ data }) => (
		<>
			<PageHead title="Telemetry sources" description="Applications, environments and services known to Operations." />
			<SourcesView sources={data.sources.items} />
		</>
	))
