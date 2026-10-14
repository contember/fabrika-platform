// The SPA bundle as `bun run build:web` built it into `dist/web`: through the plugin it loads the contract without its
// handlers, so it holds no handler code and reaches no server module, however the shell imports them. The test reads
// the build instead of running it: inside `bun test`, Bun's bundler fails to resolve this SPA's modules, while the
// build script resolves them. `bun run test` builds first.

import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'

const SERVER_MODULE =
	/(^|\/)(implement|testing|jobs|files)\/|packages\/db\/src\/(index|store|orm|database|sql|codegen)\.ts|platform-node|^(node|bun):/
const HANDLER_CODE = ['getForUpdate', 'only a won or lost deal reopens', 'ConflictError', 'fromRow', 'ctx.transaction', 'unnest(']
const dist = join(import.meta.dir, '..', '..', 'dist')

test('the SPA bundle holds the client and the contract, no handler and no server module', async () => {
	const listed = Bun.file(join(dist, 'web.inputs.json'))
	expect(await listed.exists(), 'dist/web is missing: run `bun run build:web` (or `bun run test`) first').toBe(true)
	const inputs = z.array(z.string()).parse(await listed.json())
	for (const shell of ['fabrika.contract.ts', 'src/deals/endpoints.ts', 'src/tasks/endpoints.ts', 'web/app.tsx']) {
		expect(inputs.some((input) => input.endsWith(shell))).toBe(true)
	}
	expect(inputs.some((input) => input.endsWith('src/deals/logic.ts'))).toBe(false)
	expect(inputs.filter((input) => SERVER_MODULE.test(input))).toEqual([])
	const scripts = [...new Bun.Glob('*.js').scanSync(join(dist, 'web'))]
	const code = (await Promise.all(scripts.map((file) => Bun.file(join(dist, 'web', file)).text()))).join('\n')
	expect(code).toContain('/api')
	// The page loads its assets from the root, so a deep link such as /deals/<id> renders.
	expect(await Bun.file(join(dist, 'web', 'index.html')).text()).toMatch(/src="\/chunk-[a-z0-9]+\.js"/)
	for (const handler of HANDLER_CODE) expect(code).not.toContain(handler)
})
