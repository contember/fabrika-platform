// Builds the SPA of the application at `root` (its `web/index.html`) with Vite through `@fabrika/check/vite-plugin`,
// in a process of its own, and prints whether it succeeded and why not. `plain` builds without the plugin.

import { join } from 'node:path'
import { build } from 'vite'
import { shellSlicePlugin } from '../../vite-plugin'

const [root = '', outDir = '', mode = 'plugin'] = process.argv.slice(2)
try {
	await build({
		root: join(root, 'web'),
		configFile: false,
		logLevel: 'silent',
		plugins: mode === 'plain' ? [] : [shellSlicePlugin({ root })],
		build: { outDir, emptyOutDir: true },
	})
	console.log(JSON.stringify({ ok: true, error: '' }))
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
}
