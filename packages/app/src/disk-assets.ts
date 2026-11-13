// The SPA mounts served from their build directories on disk, as the Bun runtime adapter serves them in a deploy; the
// test kit serves a built directory the same way.

import { rawRequestTarget } from '@fabrika/auth-core'
import type { BunFile } from 'bun'
import { basename, join, resolve, sep } from 'node:path'
import type { SpaAssets } from './implement/dispatch.js'
import { isSourceMapName } from './source-map-path.js'
import { isPageRoute } from './spa-fallback.js'

/**
 * Serves each SPA mount from its build directory under `root`; a page route that names no file gets the SPA's
 * `index.html` (`isPageRoute`), and a missing asset is 404.
 */
export function diskAssets(root: string): SpaAssets {
	return {
		async serve(mount, request) {
			const dir = resolve(root, mount.dir)
			const pathname = rawRequestTarget(request.url).pathname
			const relative = mount.prefix === '/' ? pathname.slice(1) : pathname.slice(mount.prefix.length + 1)
			// The path is canonical, so every segment decodes and none is `.` or `..`.
			const file = join(dir, ...relative.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment)))
			// The mount refuses a source map before it asks; this holds for any caller that serves through it directly.
			const found = file.startsWith(`${dir}${sep}`) && !isSourceMapName(basename(file)) ? await existing(file) : null
			const served = found ?? (isPageRoute(request) ? Bun.file(join(dir, 'index.html')) : null)
			if (served === null || !(await served.exists())) {
				return new Response('Not found', { status: 404 })
			}
			return new Response(served)
		},
	}
}

/** The file at `path` when it exists. A name no file can have (a decoded control character) is a missing asset, not a fault. */
async function existing(path: string): Promise<BunFile | null> {
	try {
		const file = Bun.file(path)
		return (await file.exists()) ? file : null
	} catch {
		return null
	}
}
