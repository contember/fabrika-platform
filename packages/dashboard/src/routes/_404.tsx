import { createPage, Link } from '@buzola/router'
import { GateScreen } from '../components/GateScreen'
import { Icon } from '../components/Icon'

export default createPage()
	.render(() => (
		<GateScreen icon="search" title="Not found" status="Status 404">
			<p>That page doesn't exist in this console.</p>
			<Link to="index" className="nav-cta">
				Back to the overview
				<Icon name="arrow-right" size={14} />
			</Link>
		</GateScreen>
	))
