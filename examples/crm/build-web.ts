// The SPA build: `web/index.html` (React, `@fabrika/ui` and its stylesheet) through `@fabrika/check/bun-plugin`, which
// loads the contract without its handlers.
// `zerops.yaml` runs it (`bun run build:web`); the contract's `site` mount serves its output.

import { shellSlicePlugin } from '@fabrika/check/bun-plugin'
import { join } from 'node:path'

export async function buildWeb(outdir: string, options: { readonly metafile?: boolean; readonly minify?: boolean } = {}) {
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, 'web', 'index.html')],
		outdir,
		target: 'browser',
		// React's production build: without it the bundle carries React's development checks.
		define: { 'process.env.NODE_ENV': JSON.stringify('production') },
		minify: options.minify ?? true,
		metafile: options.metafile ?? false,
		plugins: [shellSlicePlugin({ root: import.meta.dir })],
	})
	// The mount answers `index.html` for every path under `/`, so the page loads its assets from the root: a deep link
	// such as /deals/<id> renders. Bun's `publicPath` does the same, but fails to resolve in a process that built before.
	const index = Bun.file(join(outdir, 'index.html'))
	if (built.success) await Bun.write(index, (await index.text()).replaceAll(/(src|href)="\.\//g, '$1="/'))
	return built
}

if (import.meta.main) {
	const built = await buildWeb(join(import.meta.dir, 'dist', 'web'), { metafile: true })
	if (!built.success) {
		for (const log of built.logs) console.error(String(log))
		process.exit(1)
	}
	// What the bundle holds, beside it and not served: `web/__tests__/bundle.test.ts` reads it.
	await Bun.write(join(import.meta.dir, 'dist', 'web.inputs.json'), JSON.stringify(Object.keys(built.metafile?.inputs ?? {})))
}
