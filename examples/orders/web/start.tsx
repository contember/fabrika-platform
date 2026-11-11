// The SPA's entry: the kit's stylesheet, the demo's own few rules over it, and the page rendered with its client.

import '@fabrika/ui/styles.css'
import './orders.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api'
import { Orders } from './app'

const root = document.getElementById('root')
if (root !== null) {
	createRoot(root).render(
		<StrictMode>
			<Orders clients={[api]} />
		</StrictMode>,
	)
}
