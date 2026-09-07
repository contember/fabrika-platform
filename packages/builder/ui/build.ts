import { $ } from 'bun'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(import.meta.path)
const DIST = join(ROOT, 'dist')
const ASSETS = join(DIST, 'assets')

const KERNEL_CLIENT = dirname(fileURLToPath(import.meta.resolve('@fabrika/canvas-kernel/runtime')))

function kernelClient(...segs: string[]): string {
	return join(KERNEL_CLIENT, ...segs)
}

const REACT_EXTERNALS = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime',
]
const PREACT_EXTERNALS = [
	'preact',
	'preact/hooks',
	'preact/compat',
	'preact/compat/client',
	'preact/jsx-runtime',
	'preact/jsx-dev-runtime',
]

async function buildBundle(
	label: string,
	entry: string,
	naming: string,
	external: string[],
): Promise<Bun.BuildArtifact> {
	console.log(`  building ${label} -> assets/${naming.replace('[hash]', '*')}`)
	const res = await Bun.build({
		entrypoints: [entry],
		outdir: ASSETS,
		format: 'esm',
		target: 'browser',
		minify: true,
		naming,
		external,
	})
	if (!res.success) {
		console.error(`${label} build failed:`)
		for (const log of res.logs) console.error(log)
		process.exit(1)
	}
	const out = res.outputs.find((o) => o.kind === 'entry-point')
	if (!out) {
		console.error(`${label}: no entry-point output produced.`)
		process.exit(1)
	}
	return out
}

async function build() {
	console.log('Building @fabrika/builder dashboard...')
	rmSync(DIST, { recursive: true, force: true })
	mkdirSync(ASSETS, { recursive: true })

	await buildBundle(
		'preact-compat',
		kernelClient('preact-all.ts'),
		'preact-compat.js',
		[],
	)

	const jsxShim = `import { jsx, jsxs, Fragment } from "./preact-compat.js";\n`
		+ `export { jsx, jsxs, Fragment };\n`
		+ `export const jsxDEV = jsx;\n`
	writeFileSync(join(ASSETS, 'react-jsx-runtime.js'), jsxShim)
	writeFileSync(join(ASSETS, 'react-jsx-dev-runtime.js'), jsxShim)

	await buildBundle(
		'@fabrika/annotations/runtime',
		fileURLToPath(import.meta.resolve('@fabrika/annotations/runtime')),
		'annotations-runtime.js',
		REACT_EXTERNALS,
	)
	await buildBundle(
		'#canvas/runtime',
		kernelClient('runtime.ts'),
		'runtime.js',
		[...REACT_EXTERNALS, '@fabrika/annotations/runtime'],
	)

	await buildBundle(
		'#canvas/components',
		kernelClient('components', 'index.ts'),
		'components.js',
		[...REACT_EXTERNALS, '@fabrika/annotations/runtime', '#canvas/runtime'],
	)

	const jsEntry = await buildBundle(
		'host client',
		join(ROOT, 'src', 'main.tsx'),
		'client.[hash].js',
		[...REACT_EXTERNALS, ...PREACT_EXTERNALS, '@fabrika/annotations/runtime', '#canvas/components', '#canvas/runtime'],
	)
	const jsName = jsEntry.path.split('/').pop()!

	console.log('  building CSS (tailwind v4)...')
	await $`cd ${ROOT} && bunx @tailwindcss/cli -i client/styles.css -o dist/assets/client.css --minify`.quiet()

	console.log('  writing index.html (with importmap)...')
	const importmap = {
		imports: {
			react: '/assets/preact-compat.js',
			'react-dom': '/assets/preact-compat.js',
			'react-dom/client': '/assets/preact-compat.js',
			'react/jsx-runtime': '/assets/react-jsx-runtime.js',
			'react/jsx-dev-runtime': '/assets/react-jsx-dev-runtime.js',
			preact: '/assets/preact-compat.js',
			'preact/hooks': '/assets/preact-compat.js',
			'preact/compat': '/assets/preact-compat.js',
			'preact/compat/client': '/assets/preact-compat.js',
			'preact/jsx-runtime': '/assets/react-jsx-runtime.js',
			'preact/jsx-dev-runtime': '/assets/react-jsx-dev-runtime.js',
			'#canvas/components': '/assets/components.js',
			'#canvas/runtime': '/assets/runtime.js',
			'@fabrika/annotations/runtime': '/assets/annotations-runtime.js',
		},
	}

	const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>fabrika</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Instrument+Serif&family=JetBrains+Mono:wght@400;500&display=swap" />
  <link rel="stylesheet" href="/assets/client.css" />
</head>
<body class="min-h-screen">
  <div id="root"></div>
  <script type="importmap">
${JSON.stringify(importmap, null, 2)}
  </script>
  <script type="module" src="/assets/${jsName}"></script>
</body>
</html>`
	writeFileSync(join(DIST, 'index.html'), html)

	console.log(`Build complete -> ${DIST}`)
	console.log(`  index.html (importmap)`)
	console.log(`  assets/${jsName}`)
	console.log(`  assets/{preact-compat,react-jsx-runtime,react-jsx-dev-runtime,runtime,components}.js`)
	console.log(`  assets/client.css`)
}

await build()

if (process.argv.includes('--watch')) {
	const { watch } = await import('fs')
	let t: ReturnType<typeof setTimeout> | null = null
	console.log('Watching src/ + client/ ...')
	for (const dir of ['src', 'client']) {
		watch(join(ROOT, dir), { recursive: true }, (_e, f) => {
			if (!f || f.endsWith('~')) return
			if (t) clearTimeout(t)
			t = setTimeout(() => {
				console.log(`\n  changed: ${f}`)
				build().catch((e) => console.error('rebuild failed:', e))
			}, 150)
		})
	}
}
