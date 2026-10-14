// The SPA's entry: the kit's stylesheet, the CRM's own tokens over it, and the page rendered with the page's client.

import '@fabrika/ui/styles.css'
import './crm.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api'
import { Crm } from './app'

const root = document.getElementById('root')
if (root !== null) {
	createRoot(root).render(
		<StrictMode>
			<Crm clients={[api]} />
		</StrictMode>,
	)
}
