// The SPA mounts served from their build directories on disk, as the Bun runtime adapter serves them in a deploy; the
// test kit serves a built directory the same way.

import { rawRequestTarget } from '@fabrika/auth-core'
import { join, resolve, sep } from 'node:path'
import type { SpaAssets } from './implement/dispatch.js'

/** Serves each SPA mount from its build directory under `root`; a path that names no file gets the SPA's `index.html`. */
export function diskAssets(root: string): SpaAssets {
	return {
		async serve(mount, request) {
			const dir = resolve(root, mount.dir)
			const pathname = rawRequestTarget(request.url).pathname
			const relative = mount.prefix === '/' ? pathname.slice(1) : pathname.slice(mount.prefix.length + 1)
			// The path is canonical, so every segment decodes and none is `.` or `..`.
			const file = join(dir, ...relative.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment)))
			const candidate = file.startsWith(`${dir}${sep}`) ? Bun.file(file) : null
			const served = candidate !== null && (await candidate.exists()) ? candidate : Bun.file(join(dir, 'index.html'))
			if (!(await served.exists())) {
				return new Response('Not found', { status: 404 })
			}
			return new Response(served)
		},
	}
}
