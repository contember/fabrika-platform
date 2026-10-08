import { WaitError } from '@fabrika/daemon-kit'
import { existsSync, statSync } from 'fs'
import { extname, resolve } from 'path'
import { parseArgs } from 'util'
import { BASE_URL, TIMEOUT_MS } from '../config'
import { resolveContext } from '../context'
import { pushPlan, waitForFeedback } from '../daemon-client'
import { ensureDaemon, openBrowser } from '../daemon-lifecycle'

export async function cmdGate(argv: string[]): Promise<number> {
	const sub = argv[0]
	const rest = argv.slice(1)
	if (sub === 'open') return gateOpen(rest)
	if (sub === 'wait') return gateWait(rest)
	console.error(`[fabrika] unknown gate subcommand: ${sub ?? '(none)'}. Use \`gate open\` or \`gate wait\`.`)
	return 1
}

async function gateOpen(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			view: { type: 'string' },
			dir: { type: 'string' },
			label: { type: 'string' },
			session: { type: 'string' },
			root: { type: 'string' },
		},
		allowPositionals: true,
	})

	const name = positionals[0]
	if (!name) {
		console.error('[fabrika] gate open requires a <name>. Usage: fabrika builder gate open <name> --view <file.jsx>')
		return 1
	}
	if (!values.view && !values.dir) {
		console.error('[fabrika] gate open requires exactly one of --view <file.jsx> or --dir <jsxDir>.')
		return 1
	}
	if (values.view && values.dir) {
		console.error('[fabrika] gate open accepts either --view or --dir, not both.')
		return 1
	}

	const ctx = resolveContext({ dir: values.root, session: values.session })

	let source: { view: string } | { directory: string }
	if (values.dir) {
		const directory = resolve(values.dir)
		if (!existsSync(directory) || !statSync(directory).isDirectory()) {
			console.error(`[fabrika] --dir not a directory: ${directory}`)
			return 1
		}
		source = { directory }
	} else {
		const viewPath = resolve(values.view!)
		if (!existsSync(viewPath)) {
			console.error(`[fabrika] --view file not found: ${viewPath}`)
			return 1
		}
		if (!statSync(viewPath).isFile()) {
			console.error(`[fabrika] --view must be a file; use --dir for a directory: ${viewPath}`)
			return 1
		}
		if (extname(viewPath).toLowerCase() !== '.jsx') {
			console.error(`[fabrika] --view must point to a .jsx file: ${viewPath}`)
			return 1
		}
		source = { view: viewPath }
	}

	const label = values.label ?? name
	const browserUrl = `${BASE_URL}/s/${ctx.sessionId}`

	const up = await ensureDaemon({ quiet: true })
	if (!up) {
		console.error(`[fabrika] daemon unavailable; cannot push gate "${name}".`)
		console.log(
			JSON.stringify({
				ok: false,
				reachable: false,
				gate: name,
				...source,
				browserUrl,
				hint: 'Start the daemon (fabrika builder ensure-daemon), then re-run gate open.',
			}),
		)
		return 0 // soft-fail so the loop can proceed offline / be tested
	}

	const result = await pushPlan(ctx.sessionId, {
		...source,
		projectRoot: ctx.repoRoot,
		label,
		gate: name,
	})

	if (!result.reachable || !result.ok) {
		console.error(`[fabrika] gate push failed: ${result.error ?? 'compile error'}`)
		if (result.errors) {
			for (const [file, err] of Object.entries(result.errors)) {
				console.error(`  ${file}: ${err}`)
			}
		}
		return 1
	}

	if (result.isNew && result.browserUrl) {
		openBrowser(result.browserUrl)
	}

	console.log(
		JSON.stringify({
			ok: true,
			browserUrl: result.browserUrl ?? browserUrl,
			revision: result.revision,
			gate: name,
			sessionId: ctx.sessionId,
			canvasFiles: result.canvasFiles,
		}),
	)
	return 0
}

async function gateWait(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			gate: { type: 'string' },
			timeout: { type: 'string' },
			session: { type: 'string' },
			root: { type: 'string' },
		},
		allowPositionals: true,
	})

	const ctx = resolveContext({ dir: values.root, session: values.session })
	const timeoutMs = values.timeout ? parseInt(values.timeout, 10) : TIMEOUT_MS

	const up = await ensureDaemon({ quiet: true })
	if (!up) {
		console.error('[fabrika] daemon unavailable; cannot wait for gate feedback.')
		return 1
	}

	try {
		const feedback = await waitForFeedback(ctx.sessionId, timeoutMs)
		process.stdout.write(feedback)
		return 0
	} catch (error: unknown) {
		if (error instanceof WaitError && error.reason === 'timeout') {
			console.error('[fabrika] timeout waiting for gate feedback.')
		} else {
			console.error(`[fabrika] gate wait failed: ${error instanceof Error ? error.message : String(error)}`)
		}
		return 1
	}
}
