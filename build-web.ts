// The SPA build: `web/index.html` through `@fabrika/check/bun-plugin`, which loads the contract without its handlers.
// A deploy runs it as `pipeline.build`, a local run before `bun run oblaka`; the contract's `site` mount serves its output.

import { shellSlicePlugin } from '@fabrika/check/bun-plugin'
import { join } from 'node:path'

export async function buildWeb(outdir: string, options: { readonly metafile?: boolean; readonly minify?: boolean } = {}) {
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, 'web', 'index.html')],
		outdir,
		target: 'browser',
		minify: options.minify ?? true,
		// Each map beside its file, unreferenced: staging the mount leaves `.map` files out.
		sourcemap: 'external',
		metafile: options.metafile ?? false,
		plugins: [shellSlicePlugin({ root: import.meta.dir })],
	})
	// The mount answers `index.html` for every path under `/`, so the page loads its assets from the root.
	const index = Bun.file(join(outdir, 'index.html'))
	if (built.success) await Bun.write(index, (await index.text()).replaceAll(/(src|href)="\.\//g, '$1="/'))
	return built
}

if (import.meta.main) {
	const built = await buildWeb(join(import.meta.dir, 'dist', 'web'))
	if (!built.success) {
		for (const log of built.logs) console.error(String(log))
		process.exit(1)
	}
}
