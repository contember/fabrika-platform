// The DOM of the screen tests: happy-dom's globals with Bun's own fetch kept, because the clients and the test kit run
// on it. Import it before anything else: imports evaluate in order, and React reads `window` when it loads.

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll } from 'bun:test'

const runtime = { fetch: globalThis.fetch, Request: globalThis.Request, Response: globalThis.Response, Headers: globalThis.Headers }
GlobalRegistrator.register({ url: 'http://crm.test/' })
Object.assign(globalThis, runtime)
// The tests wait for what the page shows by polling, as a person does, not inside React's act().
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
afterAll(async () => {
	// React's scheduler runs a last task after the final unmount; it still reads `window`.
	await new Promise((resolve) => setTimeout(resolve, 50))
	await GlobalRegistrator.unregister()
})
