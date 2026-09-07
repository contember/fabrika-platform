import { existsSync } from 'fs'
import { dirname, join, normalize } from 'path'

const ROOT = dirname(import.meta.path)
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env['PORT'] ?? 19411)

if (!existsSync(join(DIST, 'index.html'))) {
	console.error('dist/ not built — run `bun run build` first.')
	process.exit(1)
}

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url)
		let path = url.pathname

		if (path === '/') return Response.redirect('/s/fixture-session', 302)
		if (path.startsWith('/s/')) path = '/index.html'

		const file = Bun.file(join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, '')))
		if (await file.exists()) return new Response(file)

		return new Response(Bun.file(join(DIST, 'index.html')), {
			headers: { 'content-type': 'text/html' },
		})
	},
})

console.log(`fabrika ui preview -> http://localhost:${server.port}/s/fixture-session`)
