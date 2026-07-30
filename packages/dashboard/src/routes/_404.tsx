import { createPage, Link } from '@buzola/router'
import { Icon } from '../components/Icon'

export default createPage()
	.render(() => (
		<div className="gate-screen">
			<h1>Not found</h1>
			<p>That page doesn't exist in this console.</p>
			<Link to="index" className="nav-cta">
				Back to the overview
				<Icon name="arrow-right" size={14} />
			</Link>
		</div>
	))
