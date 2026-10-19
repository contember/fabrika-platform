import { render } from 'preact'
import { PROJECT_RE } from '../src/review/model'
import { ReviewClient } from './client'
import styles from './styles.css' with { type: 'text' }
import { ReviewWidget } from './widget'

const HOST_TAG = 'agent-canvas-review'

/**
 * `<script src="http://localhost:19400/assets/review.js" data-project="my-app"></script>` in the application under
 * review mounts the widget. Its own origin is the daemon's.
 */
function mount(script: HTMLScriptElement): void {
	const project = script.dataset['project'] ?? ''
	if (!PROJECT_RE.test(project)) {
		console.error(`agent-canvas review: data-project must match ${PROJECT_RE}, got "${project}"`)
		return
	}
	if (document.querySelector(HOST_TAG) !== null) return

	const pageStyle = document.createElement('style')
	pageStyle.textContent = 'html.agent-canvas-review-picking, html.agent-canvas-review-picking * { cursor: crosshair !important; }'
	document.head.append(pageStyle)

	const host = document.createElement(HOST_TAG)
	document.documentElement.append(host)
	const root = host.attachShadow({ mode: 'open' })
	const style = document.createElement('style')
	style.textContent = styles
	root.append(style)
	render(<ReviewWidget client={new ReviewClient(new URL(script.src).origin, project)} host={host} />, root)
}

const script = document.currentScript
if (script instanceof HTMLScriptElement) mount(script)
else console.error('agent-canvas review: load review.js with a classic <script> tag')
