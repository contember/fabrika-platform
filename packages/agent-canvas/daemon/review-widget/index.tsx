import { render } from 'preact'
import { importShareKey } from '../client/shareCrypto'
import { PROJECT_RE } from '../src/review/model'
import { formatReviewCredentials, parseReviewCredentials, REVIEW_FRAGMENT_PARAM, type ReviewCredentials } from '../src/review/remote'
import { DaemonReviewClient, type ReviewClient } from './client'
import { RemoteReviewClient } from './remote-client'
import styles from './styles.css' with { type: 'text' }
import { ReviewWidget } from './widget'

const HOST_TAG = 'agent-canvas-review'
const REMOTE_KEY = 'agent-canvas-review:remote'
const FORGET = 'off'

/**
 * The reviewer's link carries the remote project and its key in the fragment, which never reaches a server. The page
 * keeps them for its origin, so navigation and later visits keep the widget; `#agent-canvas-review=off` forgets them.
 */
function takeRemoteCredentials(): ReviewCredentials | null {
	const fromLink = new URLSearchParams(location.hash.slice(1)).get(REVIEW_FRAGMENT_PARAM)
	if (fromLink !== null) {
		// The key must not stay in the address bar, the history, or the page URL a thread records.
		history.replaceState(history.state, '', `${location.pathname}${location.search}`)
		if (fromLink === FORGET) {
			try {
				localStorage.removeItem(REMOTE_KEY)
			} catch {}
			return null
		}
		const credentials = parseReviewCredentials(fromLink)
		if (credentials === null) {
			console.error('agent-canvas review: the review link is malformed')
			return null
		}
		try {
			localStorage.setItem(REMOTE_KEY, formatReviewCredentials(credentials))
		} catch {}
		return credentials
	}
	try {
		const stored = localStorage.getItem(REMOTE_KEY)
		return stored === null ? null : parseReviewCredentials(stored)
	} catch {
		return null
	}
}

function mountWidget(client: ReviewClient): void {
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
	render(<ReviewWidget client={client} host={host} />, root)
}

/**
 * - `<script src="http://localhost:19400/assets/review.js" data-project="my-app"></script>`: the local daemon keeps the
 *   threads.
 * - `<script src="https://<share worker>/assets/review.js"></script>`: a remote project on the share worker, mounted
 *   only for a reviewer who opened its link.
 */
async function mount(script: HTMLScriptElement): Promise<void> {
	const origin = new URL(script.src).origin
	const project = script.dataset['project']
	if (project !== undefined) {
		if (!PROJECT_RE.test(project)) {
			console.error(`agent-canvas review: data-project must match ${PROJECT_RE}, got "${project}"`)
			return
		}
		mountWidget(new DaemonReviewClient(origin, project))
		return
	}
	const credentials = takeRemoteCredentials()
	if (credentials === null) return
	mountWidget(new RemoteReviewClient(origin, credentials.projectId, await importShareKey(credentials.key)))
}

const script = document.currentScript
if (script instanceof HTMLScriptElement) {
	void mount(script)
	// A link opened on a page already showing loads no new document; reloading lets it mount or forget the project.
	if (script.dataset['project'] === undefined) {
		window.addEventListener('hashchange', () => {
			if (new URLSearchParams(location.hash.slice(1)).has(REVIEW_FRAGMENT_PARAM)) location.reload()
		})
	}
} else console.error('agent-canvas review: load review.js with a classic <script> tag')
