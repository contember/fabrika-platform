import { plugin } from 'bun'
import { fileURLToPath } from 'url'

const fakePath = fileURLToPath(new URL('./fake-kernel.ts', import.meta.url))

plugin({
	name: 'fake-canvas-kernel',
	setup(build) {
		build.onResolve({ filter: /^@fabrika\/canvas-kernel(\/server)?$/ }, () => ({ path: fakePath }))
	},
})
