import { existsSync, watch } from 'fs'
import { type CanvasComponents, compileJsx } from './compiler'
import { assertCanvasFileReadable, type AssertReadable, readCanvasFile } from './file-admission'
import type { SessionManager } from './session'

type BroadcastFn = (sessionId: string) => void

export interface WatchOptions {
	assertReadable?: AssertReadable
	/** Scratch dir for recompiles, from `createCanvasPaths()`. */
	tempDir?: string
	/** Host components, same value the push path compiles with — a recompile
	 *  that dropped them would fail on canvases the original push accepted. */
	components?: CanvasComponents
}

const watchers = new Map<string, ReturnType<typeof watch>[]>()

export function watchSession(
	sessionId: string,
	sessionManager: SessionManager,
	broadcast: BroadcastFn,
	options: WatchOptions = {},
) {
	// Close existing watchers for this session
	unwatchSession(sessionId)

	const session = sessionManager.get(sessionId)
	if (!session) return

	const rev = session.currentRevision
	const canvasFiles = sessionManager.getRevisionCanvasFiles(sessionId, rev)
	if (canvasFiles.length === 0) return

	const fileWatchers: ReturnType<typeof watch>[] = []
	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
	const sources: { filename: string; filePath: string }[] = []

	for (const filename of canvasFiles) {
		const filePath = sessionManager.getRevisionJsxPath(sessionId, rev, filename)
		if (!existsSync(filePath)) continue
		assertCanvasFileReadable(filePath, options.assertReadable)
		sources.push({ filename, filePath })
	}

	for (const { filename, filePath } of sources) {
		const watcher = watch(filePath, async (event) => {
			if (event !== 'change') return

			// Debounce per-file
			const existing = debounceTimers.get(filename)
			if (existing) clearTimeout(existing)

			debounceTimers.set(
				filename,
				setTimeout(async () => {
					debounceTimers.delete(filename)
					try {
						const jsx = readCanvasFile(filePath, options.assertReadable)
						const result = await compileJsx(jsx, {
							projectRoot: session.projectRoot,
							tempDir: options.tempDir,
							assertReadable: options.assertReadable,
							...(options.components ? { components: options.components } : {}),
						})
						if (result.ok) {
							sessionManager.saveCompiled(sessionId, filename, result.js, rev)
							broadcast(sessionId)
						}
					} catch {}
				}, 200),
			)
		})

		fileWatchers.push(watcher)
	}

	watchers.set(sessionId, fileWatchers)
}

export function unwatchSession(sessionId: string) {
	const sessionWatchers = watchers.get(sessionId)
	if (sessionWatchers) {
		for (const w of sessionWatchers) w.close()
		watchers.delete(sessionId)
	}
}

export function unwatchAll() {
	for (const [, sessionWatchers] of watchers) {
		for (const w of sessionWatchers) w.close()
	}
	watchers.clear()
}
