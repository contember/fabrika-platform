import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { scratchDir } from './scratch'

if (process.env['FABRIKA_CANVAS_CUSTODY_CHILD'] !== '1') {
	test('canvas custody with the real kernel in a process without the fake preload', async () => {
		const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
			env: { ...process.env, FABRIKA_CANVAS_CUSTODY_CHILD: '1' },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
		expect({ code, output: code === 0 ? '' : stdout + stderr }).toEqual({ code: 0, output: '' })
	}, 30_000)
} else {
	const { compileJsx, SessionManager, watchSession, unwatchSession, unwatchAll } = await import('@fabrika/canvas-kernel/server')
	const { dispatch } = await import('@fabrika/daemon-kit')
	const { createHandlers } = await import('../src/handlers')
	const { BuilderPlatform } = await import('../src/platform')
	const { BuildStream } = await import('../src/build-stream')

	function fixture() {
		const directory = scratchDir('canvas-custody-')
		const root = join(directory, 'project')
		const keys = join(directory, 'keys')
		const state = join(directory, 'state')
		const sessions = join(directory, 'data', 'sessions')
		for (const dir of [root, keys, state]) mkdirSync(dir, { recursive: true, mode: 0o700 })
		const sm = new SessionManager(sessions)
		const platform = new BuilderPlatform((id) => sm.get(id)?.projectRoot, {
			credentialDir: keys,
			stateDir: state,
			dataDir: join(directory, 'data'),
		})
		const assertReadable = (path: string) => platform.storage.assertPublicFile(path)
		const options = { projectRoot: root, tempDir: join(directory, 'compile'), assertReadable }
		const routes = createHandlers({
			sessionManager: sm,
			platform,
			sessionsDir: sessions,
			broadcastPlanUpdate: () => {},
			broadcastRevisionUpdate: () => {},
			buildStream: new BuildStream(),
			port: 19410,
			version: 'test',
		})
		async function request(path: string, body?: unknown) {
			const req = new Request(
				`http://localhost:19410${path}`,
				body === undefined ? {} : {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				},
			)
			const response = await dispatch(routes, req, new URL(req.url))
			if (!response) throw new Error('Missing test route')
			return response
		}
		return {
			directory,
			root,
			keys,
			state,
			sm,
			options,
			request,
			close() {
				unwatchAll()
				platform.stop()
				rmSync(directory, { recursive: true, force: true })
			},
		}
	}

	test('embedded Markdown and FilePreview refuse protected absolute, relative and symlink paths without disclosing them', async () => {
		const f = fixture()
		try {
			for (const dir of [f.keys, f.state]) {
				const secret = join(dir, 'credential.txt')
				writeFileSync(secret, 'custody-secret')
				const link = join(f.root, 'linked.txt')
				symlinkSync(secret, link)
				for (const path of [secret, relative(f.root, secret), 'linked.txt']) {
					for (const jsx of [`<Markdown file="${path}" />`, `<FilePreview path="${path}" />`]) {
						expect(await compileJsx(jsx, f.options)).toEqual({ ok: false, error: 'Canvas file access refused' })
					}
				}
				unlinkSync(link)
			}
			writeFileSync(join(f.root, 'public.txt'), 'public-preview')
			for (const jsx of ['<Markdown file="public.txt" />', '<FilePreview path="public.txt" />']) {
				const result = await compileJsx(jsx, f.options)
				expect(result.ok).toBe(true)
				if (result.ok) expect(result.js).toContain('public-preview')
			}
		} finally {
			f.close()
		}
	})

	test('Bun imports guard JS, JSON and text, including transitive symlink dependencies', async () => {
		const f = fixture()
		try {
			for (
				const [name, content] of [
					['credential.js', 'export default "custody-secret"'],
					['credential.json', '"custody-secret"'],
					['credential.txt', 'custody-secret'],
				]
			) {
				if (!name || !content) throw new Error('Invalid fixture')
				const secret = join(f.keys, name)
				writeFileSync(secret, content)
				const source = (path: string) => `import value from ${JSON.stringify(path)}; export default function Plan() { return <div>{value}</div> }`
				expect(await compileJsx(source(secret), f.options)).toEqual({ ok: false, error: 'Canvas file access refused' })
				const link = join(f.root, name)
				symlinkSync(secret, link)
				const dependency = join(f.root, 'dependency.js')
				writeFileSync(dependency, `export { default } from ${JSON.stringify(link)}`)
				expect(await compileJsx(source(dependency), f.options)).toEqual({ ok: false, error: 'Canvas file access refused' })
				unlinkSync(link)
				const publicFile = join(f.root, `public-${name}`)
				writeFileSync(publicFile, content.replace('custody-secret', 'public-import'))
				const result = await compileJsx(source(publicFile), f.options)
				if (!result.ok) throw new Error(`${name}: ${result.error}`)
				expect(result.ok).toBe(true)
				if (result.ok) expect(result.js).toContain('public-import')
			}
		} finally {
			f.close()
		}
	})

	test('guarded compilation does not expose protected package metadata in responses or process logs', async () => {
		const f = fixture()
		try {
			const secret = join(f.keys, 'metadata.json')
			writeFileSync(secret, '{ "name": custody-metadata-secret-marker }')
			const dependency = join(f.root, 'dependency')
			mkdirSync(dependency)
			symlinkSync(secret, join(dependency, 'package.json'))
			const module = join(dependency, 'index.js')
			writeFileSync(module, 'export default 1')
			const jsx = `import value from ${JSON.stringify(module)}; export default function Plan() { return <div>{value}</div> }`
			const code = `
				import { compileJsx } from ${JSON.stringify(import.meta.resolve('@fabrika/canvas-kernel/server'))};
				import { realpathSync } from 'node:fs';
				const result = await compileJsx(${JSON.stringify(jsx)}, {
					tempDir: ${JSON.stringify(f.options.tempDir)},
					assertReadable(path) { if (realpathSync(path) === ${JSON.stringify(secret)}) throw new Error('refused'); }
				});
				console.log(JSON.stringify(result));
			`
			const child = Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' })
			const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
			expect(exitCode).toBe(0)
			expect(stdout + stderr).not.toContain('custody-metadata-secret-marker')
			expect(stdout + stderr).not.toContain(secret)
			expect(JSON.parse(stdout)).toEqual({ ok: false, error: 'Canvas compilation failed' })
			const view = join(f.root, 'view.jsx')
			writeFileSync(view, jsx)
			const response = await f.request('/api/session/test/plan', { view, projectRoot: f.root })
			expect(response.status).toBe(400)
			const body = await response.text()
			expect(body).not.toContain('custody-metadata-secret-marker')
			expect(body).not.toContain(secret)
		} finally {
			f.close()
		}
	})

	test('failed multi-canvas watcher admission leaves no callbacks after unwatch or retry', async () => {
		const f = fixture()
		try {
			const secret = join(f.keys, 'credential.jsx')
			writeFileSync(secret, '<div>custody-secret</div>')
			f.sm.upsert('test', new Map([['a.jsx', '<div>first</div>'], ['b.jsx', '<div>second</div>']]), f.root)
			const first = f.sm.getRevisionJsxPath('test', 1, 'a.jsx')
			const second = f.sm.getRevisionJsxPath('test', 1, 'b.jsx')
			unlinkSync(second)
			symlinkSync(secret, second)
			let failedCallbacks = 0
			expect(() => watchSession('test', f.sm, () => failedCallbacks++, f.options)).toThrow('Canvas file access refused')
			unwatchSession('test')
			writeFileSync(first, '<div>after-failed-setup</div>')
			await Bun.sleep(500)
			expect(failedCallbacks).toBe(0)
			expect(f.sm.getCompiled('test', 'a.jsx')).toBeNull()
			unlinkSync(second)
			writeFileSync(second, '<div>allowed-second</div>')
			let retryCallbacks = 0
			watchSession('test', f.sm, () => retryCallbacks++, f.options)
			writeFileSync(first, '<div>after-retry</div>')
			for (let i = 0; i < 100 && retryCallbacks === 0; i++) await Bun.sleep(20)
			expect(retryCallbacks).toBe(1)
			expect(failedCallbacks).toBe(0)
			unwatchSession('test')
			writeFileSync(first, '<div>after-unwatch</div>')
			await Bun.sleep(500)
			expect(retryCallbacks).toBe(1)
			expect(failedCallbacks).toBe(0)
		} finally {
			f.close()
		}
	})

	test('guarded compilation disables Bun macros and ignores project compiler configuration', async () => {
		const f = fixture()
		try {
			const marker = join(f.directory, 'macro-executed')
			const macro = join(f.root, 'macro.ts')
			const credential = join(f.keys, 'credential.txt')
			writeFileSync(credential, 'custody-macro-secret')
			writeFileSync(
				macro,
				`import { readFileSync, writeFileSync } from 'node:fs';
				export function secret() {
					writeFileSync(${JSON.stringify(marker)}, 'executed');
					return readFileSync(${JSON.stringify(credential)}, 'utf8');
				}`,
			)
			writeFileSync(join(f.root, 'tsconfig.json'), JSON.stringify({ extends: join(f.keys, 'credential.json') }))
			const macroImport = `import { secret } from ${JSON.stringify(macro)} with { type: 'macro' };`
			const sources = [`${macroImport} const value = secret(); export default function Plan() { return <div>{value}</div> }`]
			for (const extension of ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts']) {
				const dependency = join(f.root, `dependency.${extension}`)
				writeFileSync(dependency, `${macroImport} export default secret();`)
				const bridge = join(f.root, `bridge-${extension}.ts`)
				writeFileSync(bridge, `export { default } from ${JSON.stringify(dependency)};`)
				sources.push(`import value from ${JSON.stringify(bridge)}; export default function Plan() { return <div>{value}</div> }`)
			}
			for (const source of sources) {
				const result = await compileJsx(source, f.options)
				expect(existsSync(marker)).toBe(false)
				expect(JSON.stringify(result)).not.toContain('custody-macro-secret')
				expect(result).toEqual({ ok: false, error: 'Canvas compilation failed' })
			}
			const publicJs = join(f.root, 'public.js')
			const publicTs = join(f.root, 'public.ts')
			writeFileSync(publicJs, 'export const value = "public-transitive-import";')
			writeFileSync(publicTs, `import { value } from ${JSON.stringify(publicJs)}; const typed: string = value; export default typed;`)
			const publicResult = await compileJsx(
				`import value from ${JSON.stringify(publicTs)}; export default function Plan() { return <div>{value}</div> }`,
				f.options,
			)
			expect(publicResult.ok).toBe(true)
			if (publicResult.ok) expect(publicResult.js).toContain('public-transitive-import')
			expect((await compileJsx('<div>public</div>', f.options)).ok).toBe(true)
		} finally {
			f.close()
		}
	})

	test('guarded compilation refuses direct and transitive data URL imports before macros execute', async () => {
		const f = fixture()
		try {
			const marker = join(f.directory, 'data-url-macro-executed')
			const credential = join(f.keys, 'credential.txt')
			const macro = join(f.root, 'macro.ts')
			writeFileSync(credential, 'custody-data-url-secret')
			writeFileSync(
				macro,
				`import { readFileSync, writeFileSync } from 'node:fs';
				export function secret() {
					writeFileSync(${JSON.stringify(marker)}, 'executed');
					return readFileSync(${JSON.stringify(credential)}, 'utf8');
				}`,
			)
			const module = `import { secret } from ${JSON.stringify(macro)} with { type: 'macro' }; export default secret();`
			for (
				const url of [`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`, `data:text/javascript,${encodeURIComponent(module)}`]
			) {
				const dependency = join(f.root, 'dependency.ts')
				writeFileSync(dependency, `export { default } from ${JSON.stringify(url)};`)
				for (const specifier of [url, dependency]) {
					const result = await compileJsx(
						`import value from ${JSON.stringify(specifier)}; export default function Plan() { return <div>{value}</div> }`,
						f.options,
					)
					expect(existsSync(marker)).toBe(false)
					expect(JSON.stringify(result)).not.toContain('custody-data-url-secret')
					expect(result).toEqual({ ok: false, error: 'Canvas file access refused' })
				}
			}
		} finally {
			f.close()
		}
	})

	test('Builder guards initial source, stale compiled revisions, current recompiles and revision source symlinks', async () => {
		const f = fixture()
		try {
			const secret = join(f.keys, 'credential.jsx')
			writeFileSync(secret, '<div>custody-secret</div>')
			expect((await f.request('/api/session/test/plan', { view: secret, projectRoot: f.root })).status).toBe(400)
			const view = join(f.root, 'view.jsx')
			writeFileSync(view, `<FilePreview path="${secret}" />`)
			expect((await f.request('/api/session/test/plan', { view, projectRoot: f.root })).status).toBe(400)
			f.sm.upsert('test', new Map([['view.jsx', readFileSync(view, 'utf8')]]), f.root)
			f.sm.saveCompiled('test', 'view.jsx', 'custody-secret')
			for (const suffix of ['', '?rev=1']) {
				const response = await f.request(`/api/session/test/canvas/view.js${suffix}`)
				expect(response.status).toBe(400)
				expect(await response.text()).not.toContain('custody-secret')
			}
			const revisionPath = f.sm.getRevisionJsxPath('test', 1, 'view.jsx')
			unlinkSync(revisionPath)
			symlinkSync(secret, revisionPath)
			expect((await f.request('/api/session/test/canvas/view.js?rev=1')).status).toBe(403)
			unlinkSync(revisionPath)
			writeFileSync(revisionPath, '<div>public-revision</div>')
			const allowed = await f.request('/api/session/test/canvas/view.js?rev=1')
			expect(allowed.status).toBe(200)
			expect(await allowed.text()).toContain('public-revision')
			writeFileSync(view, '<div>public-push</div>')
			expect((await f.request('/api/session/test/plan', { view, projectRoot: f.root })).status).toBe(200)
		} finally {
			f.close()
		}
	})

	test('watcher refuses protected revision sources and embedded dependencies during recompilation', async () => {
		const f = fixture()
		try {
			const secret = join(f.keys, 'credential.jsx')
			writeFileSync(secret, '<div>custody-secret</div>')
			f.sm.upsert('test', new Map([['view.jsx', '<div>public</div>']]), f.root)
			const source = f.sm.getRevisionJsxPath('test', 1, 'view.jsx')
			let broadcasts = 0
			watchSession('test', f.sm, () => broadcasts++, f.options)
			writeFileSync(source, '<div>watched-public</div>')
			for (let i = 0; i < 100 && broadcasts === 0; i++) await Bun.sleep(20)
			expect(broadcasts).toBe(1)
			writeFileSync(source, `<Markdown file="${secret}" />`)
			await Bun.sleep(500)
			expect(broadcasts).toBe(1)
			expect(f.sm.getCompiled('test', 'view.jsx')).toContain('watched-public')
			unwatchAll()
			unlinkSync(source)
			symlinkSync(secret, source)
			expect(() => watchSession('test', f.sm, () => broadcasts++, f.options)).toThrow('Canvas file access refused')
		} finally {
			f.close()
		}
	})
}
