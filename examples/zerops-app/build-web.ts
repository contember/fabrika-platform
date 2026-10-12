// The SPA build: `web/index.html` through `@fabrika/check/bun-plugin`, which loads the contract without its handlers.
// `zerops.yaml` runs it (`bun run build:web`); the contract's `site` mount serves its output.

import { shellSlicePlugin } from '@fabrika/check/bun-plugin'
import { join } from 'node:path'

export const buildWeb = (outdir: string, options: { readonly metafile?: boolean; readonly minify?: boolean } = {}) =>
	Bun.build({
		entrypoints: [join(import.meta.dir, 'web', 'index.html')],
		outdir,
		target: 'browser',
		minify: options.minify ?? true,
		metafile: options.metafile ?? false,
		plugins: [shellSlicePlugin({ root: import.meta.dir })],
	})

if (import.meta.main) {
	const built = await buildWeb(join(import.meta.dir, 'dist', 'web'))
	if (!built.success) {
		for (const log of built.logs) console.error(String(log))
		process.exit(1)
	}
}
