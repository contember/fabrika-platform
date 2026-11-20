// The SPA: whom the proxy admitted, through the typed client of the `/api` mount. It imports the contract only; the
// SPA build loads the contract without its handlers.

import { createClient } from '@fabrika/app/client'
import { contract } from '../fabrika.contract'

const api = createClient(contract, 'api', { bounceOnAuth: true })

const me = document.getElementById('me')
if (me !== null) {
	api.me().then(
		(person) => {
			me.textContent = `Signed in as ${person.label}`
		},
		(error: unknown) => {
			me.textContent = error instanceof Error ? error.message : 'The request failed'
		},
	)
}
