// Runs a built SPA page in happy-dom, in a process of its own: an `#app` element, then the module scripts its
// `index.html` names, with a `fetch` that records each request and answers `answer` as the RPC envelope. Prints the
// requests and the `#app` text.

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [outDir = '', answer = 'null'] = process.argv.slice(2)
const requests: { method: string; url: string; body: string }[] = []

GlobalRegistrator.register({ url: 'https://crm.example.test/' })
// happy-dom's own fetch would go to the network: the page's calls meet this stand-in for the application.
Reflect.set(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const request = new Request(input, init)
	requests.push({ method: request.method, url: request.url, body: await request.text() })
	return Response.json({ result: JSON.parse(answer) })
})

document.body.innerHTML = '<div id="app"></div>'
const html = readFileSync(join(outDir, 'index.html'), 'utf8')
for (const [, src = ''] of html.matchAll(/<script type="module"[^>]* src="\/([^"]+)"/g)) {
	await import(pathToFileURL(join(outDir, src)).href)
}
const app = document.getElementById('app')
for (let tick = 0; tick < 100 && app?.textContent === ''; tick++) await new Promise((resolve) => setTimeout(resolve, 10))
console.log(JSON.stringify({ requests, text: app?.textContent ?? '' }))
await GlobalRegistrator.unregister()
