import { ensureRuntimeDir } from '@fabrika/daemon-kit'
import { existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve, sep } from 'path'
import { parseArgs } from 'util'
import { z } from 'zod'
import { cliAuthHeaders } from '../cli-auth.ts'
import { BASE_URL } from '../config.ts'
import { ensureDaemon, startDaemon, stopDaemon } from '../daemon-lifecycle.ts'
import { getSessionId, openLink } from '../helpers.ts'

const pushResponseSchema = z.union([
	z.object({
		ok: z.literal(true),
		browserUrl: z.string(),
		isNew: z.boolean(),
		revision: z.number(),
		canvasFiles: z.array(z.string()),
	}),
	z.object({
		ok: z.literal(false).optional(),
		error: z.string().optional(),
		errors: z.record(z.unknown()).optional(),
		unconsumedFeedback: z.string().optional(),
	}),
])

/**
 * A skill installed before `agent-canvas dir` keeps canvases in `<tmpdir>/agent-canvas`, which the daemon no longer
 * closes; the push keeps it private as the daemon did, and refuses one that is a symlink or another user's.
 */
function assertPrivateLegacyDirectory(path: string): void {
	const legacy = join(tmpdir(), 'agent-canvas')
	if (path !== legacy && !path.startsWith(legacy + sep)) return
	try {
		ensureRuntimeDir(legacy)
	} catch (error: unknown) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
		console.error('Run `bunx agent-canvas install` to update the skill: it keeps canvases in the directory `agent-canvas dir` prints.')
		process.exit(1)
	}
}

export async function handlePush(args: string[]) {
	const { values, positionals } = parseArgs({
		args,
		options: {
			session: { type: 'string' },
			label: { type: 'string' },
			response: { type: 'string' },
		},
		allowPositionals: true,
	})

	const target = positionals[0]
	if (!target) {
		console.error('Error: No directory specified. Usage: agent-canvas push <directory>')
		process.exit(1)
	}

	const resolvedPath = resolve(target)
	if (!existsSync(resolvedPath)) {
		console.error(`Error: Path not found: ${resolvedPath}`)
		process.exit(1)
	}

	if (statSync(resolvedPath).isFile()) {
		console.error(`Error: Expected a directory, got a file: ${resolvedPath}`)
		console.error('Usage: agent-canvas push <directory>')
		process.exit(1)
	}

	assertPrivateLegacyDirectory(resolvedPath)

	const sessionId = getSessionId(values.session)
	const projectRoot = process.env.CANVAS_PROJECT_ROOT || process.cwd()
	const label = values.label
	const autoLabel = !label ? basename(resolvedPath) : undefined

	await ensureDaemon()

	const response = await fetch(`${BASE_URL}/api/session/${sessionId}/plan`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...cliAuthHeaders() },
		body: JSON.stringify({
			directory: resolvedPath,
			projectRoot,
			label: label || autoLabel,
			...(values.response ? { response: values.response } : {}),
		}),
	})

	let result = pushResponseSchema.parse(await response.json())

	// Bun.build() / Bun.Transpiler can fail in long-running daemons due to
	// internal state corruption, CWD unlinking, etc. Restart and retry once.
	// Skip restart only for clear user errors (syntax errors with line/col,
	// runtime validation errors) — those won't be fixed by a restart.
	const isUserError = !result.ok && result.errors && Object.values(result.errors).every((e) =>
		typeof e === 'string' && (
			/\(line \d+, col \d+\)/.test(e)
			|| /Syntax Error|Parse error|Mermaid syntax error/i.test(e)
			|| e.startsWith('Runtime error:')
		)
	)
	const shouldRestart = !result.ok && result.error === 'Canvas compilation failed' && !isUserError
	if (shouldRestart) {
		console.error('Compilation failed, restarting daemon and retrying...')
		await stopDaemon()
		await startDaemon()
		const retryResponse = await fetch(`${BASE_URL}/api/session/${sessionId}/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...cliAuthHeaders() },
			body: JSON.stringify({
				directory: resolvedPath,
				projectRoot,
				label: label || autoLabel,
				...(values.response ? { response: values.response } : {}),
			}),
		})
		result = pushResponseSchema.parse(await retryResponse.json())
	}

	if (!result.ok) {
		if (result.unconsumedFeedback) {
			console.error(`Error: ${result.error}`)
			console.log(result.unconsumedFeedback)
		} else {
			console.error(`Compilation error:\n${result.error}`)
			if (result.errors) {
				for (const [file, err] of Object.entries(result.errors)) {
					console.error(`  ${file}: ${err}`)
				}
			}
		}
		process.exit(1)
	}

	if (result.isNew) {
		openLink(result.browserUrl)
	}

	console.log(JSON.stringify({
		ok: true,
		browserUrl: result.browserUrl,
		revision: result.revision,
		sessionId,
		canvasFiles: result.canvasFiles,
	}))
}
