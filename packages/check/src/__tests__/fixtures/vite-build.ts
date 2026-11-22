// Builds the SPA of the application at `root` (its `web/index.html`) with Vite through `@fabrika/check/vite-plugin`,
// in a process of its own, and prints whether it succeeded and why not, and the ids of the modules the bundle holds.
// `plain` builds without the plugin; `web` gives the plugin `web/` as its root, as a config run from there would.

import { join } from 'node:path'
import { build } from 'vite'
import { shellSlicePlugin } from '../../vite-plugin'

const [root = '', outDir = '', mode = 'plugin'] = process.argv.slice(2)
try {
	const result = await build({
		root: join(root, 'web'),
		configFile: false,
		logLevel: 'silent',
		plugins: mode === 'plain' ? [] : [shellSlicePlugin({ root: mode === 'web' ? join(root, 'web') : root })],
		build: { outDir, emptyOutDir: true },
	})
	const outputs = Array.isArray(result) ? result : 'output' in result ? [result] : []
	const modules = outputs.flatMap((output) => output.output.flatMap((chunk) => (chunk.type === 'chunk' ? Object.keys(chunk.modules) : [])))
	console.log(JSON.stringify({ ok: true, error: '', modules }))
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), modules: [] }))
}
