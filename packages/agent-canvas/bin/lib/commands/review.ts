import { waitForEvent } from '@fabrika/daemon-kit'
import { execFileSync } from 'child_process'
import { basename } from 'path'
import { parseArgs } from 'util'
import { z } from 'zod'
import { PROJECT_RE, reviewThreadSchema } from '../../../daemon/src/review/model.ts'
import { BASE_URL, TIMEOUT_MS, WS_URL } from '../config.ts'
import { ensureDaemon } from '../daemon-lifecycle.ts'
import { openBrowser } from '../helpers.ts'

const USAGE = `agent-canvas review — comments on a running application

  agent-canvas review open <url> [--follow] [--no-open]
                                            Serve the app at <url> with the review widget, open it in the
                                            browser and print the address; --follow then watches as below
  agent-canvas review snippet               Print the <script> tag that adds the review widget to the app
  agent-canvas review watch                 Wait for threads the reviewer sends (blocks)
  agent-canvas review watch --follow        Keep waiting; print every batch the reviewer sends
  agent-canvas review fetch                 Take the threads already sent (returns immediately)
  agent-canvas review reply <thread> <text> [--resolve]
                                            Answer a thread; --resolve closes it
  agent-canvas review list                  Show every thread that is not resolved

Every command takes --project <name>; it defaults to CANVAS_REVIEW_PROJECT, then to the git repository's directory name.`

const claimSchema = z.union([z.object({ found: z.literal(false) }), z.object({ found: z.literal(true), markdown: z.string() })])
const threadsSchema = z.object({ threads: z.array(reviewThreadSchema) })
const proxySchema = z.object({ url: z.string() })
const errorSchema = z.object({ error: z.string() })

function defaultProject(): string {
	const fromEnv = process.env.CANVAS_REVIEW_PROJECT
	if (fromEnv !== undefined && fromEnv !== '') return fromEnv
	let root = process.cwd()
	try {
		root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
	} catch {}
	return basename(root).replace(/[^A-Za-z0-9._-]/g, '-')
}

async function call(project: string, method: string, path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(`${BASE_URL}/api/review/${encodeURIComponent(project)}${path}`, {
		method,
		...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
	})
	const result: unknown = await response.json()
	if (!response.ok) {
		const error = errorSchema.safeParse(result)
		throw new Error(error.success ? error.data.error : `Daemon answered ${response.status}`)
	}
	return result
}

async function claim(project: string): Promise<string | undefined> {
	const result = claimSchema.parse(await call(project, 'POST', '/claim'))
	return result.found ? result.markdown : undefined
}

function waitForRequests(project: string): Promise<string> {
	return waitForEvent<string>({
		url: `${WS_URL}/ws/review-wait/${encodeURIComponent(project)}`,
		// The frame only announces new threads; claiming them is what hands them over, exactly once.
		onFrame: (frame) => (typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'queued' ? { type: 'recheck' } : undefined),
		probe: async () => {
			const markdown = await claim(project)
			return markdown === undefined ? undefined : { value: markdown }
		},
		alreadyProbed: true,
		timeoutMs: TIMEOUT_MS,
		reconnect: { attempts: 3, delayMs: 1_000 },
		messages: {
			timeout: 'Timeout waiting for review requests.',
			closed: 'WebSocket closed before the reviewer sent anything.',
			connectionFailed: 'WebSocket connection failed.',
		},
	})
}

const FOLLOW_RECONNECT_MS = 2_000
const FOLLOW_GIVE_UP_MS = 60_000

/**
 * The streaming watcher for hosts that turn each output line into an event (Claude Code's Monitor). One socket stays
 * open, so the reviewer keeps seeing an agent listening between batches. Status goes to stderr; stdout carries only
 * batches and the line that ends the watch, so every stdout event is worth acting on.
 */
function followRequests(project: string): Promise<never> {
	let claiming = Promise.resolve()
	let unreachableSince: number | null = null

	const claimAndPrint = () => {
		claiming = claiming.then(async () => {
			const markdown = await claim(project)
			if (markdown !== undefined) process.stdout.write(`${markdown}\n`)
		}).catch((error: unknown) => {
			console.error(`review watch: claim failed: ${error instanceof Error ? error.message : String(error)}`)
		})
	}

	const connect = () => {
		const socket = new WebSocket(`${WS_URL}/ws/review-wait/${encodeURIComponent(project)}`)
		socket.onopen = () => {
			unreachableSince = null
			console.error(`review watch: listening for ${project}`)
			claimAndPrint()
		}
		socket.onmessage = (event) => {
			// Any frame on the wait socket means "something was queued"; the claim reads what, so the frame needs no parsing.
			if (typeof event.data === 'string') claimAndPrint()
		}
		socket.onclose = () => {
			unreachableSince ??= Date.now()
			if (Date.now() - unreachableSince > FOLLOW_GIVE_UP_MS) {
				console.log(`review watch: the daemon at ${BASE_URL} has been unreachable for a minute; stopped watching ${project}.`)
				process.exit(1)
			}
			setTimeout(connect, FOLLOW_RECONNECT_MS)
		}
	}

	connect()
	return new Promise<never>(() => {})
}

export async function handleReview(args: string[]) {
	const [subcommand, ...rest] = args
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: {
			project: { type: 'string' },
			resolve: { type: 'boolean', default: false },
			follow: { type: 'boolean', default: false },
			'no-open': { type: 'boolean', default: false },
		},
	})
	const project = values.project ?? defaultProject()
	if (!PROJECT_RE.test(project)) throw new Error(`Invalid project name "${project}"; use letters, digits, ".", "_" and "-"`)

	switch (subcommand) {
		case 'open': {
			const [target] = positionals
			if (target === undefined) throw new Error('Usage: agent-canvas review open <url> [--follow] [--no-open]')
			await ensureDaemon()
			const { url } = proxySchema.parse(await call(project, 'POST', '/proxy', { target: new URL(target).href }))
			console.log(`Review ${target} at ${url}`)
			if (!values['no-open']) openBrowser(url)
			if (values.follow) return followRequests(project)
			return
		}
		case 'snippet':
			console.log(`<script src="${BASE_URL}/assets/review.js" data-project="${project}"></script>`)
			return
		case 'watch': {
			await ensureDaemon()
			if (values.follow) return followRequests(project)
			process.stdout.write((await claim(project)) ?? (await waitForRequests(project)))
			return
		}
		case 'fetch': {
			await ensureDaemon()
			const markdown = await claim(project)
			process.stdout.write(markdown ?? 'No review requests are waiting.\n')
			return
		}
		case 'reply': {
			const [threadId, ...words] = positionals
			const body = words.join(' ')
			if (threadId === undefined || body.trim() === '') throw new Error('Usage: agent-canvas review reply <thread> <text> [--resolve]')
			await ensureDaemon()
			await call(project, 'POST', `/threads/${encodeURIComponent(threadId)}/reply`, { body, resolve: values.resolve })
			console.log(values.resolve ? `Replied to ${threadId} and resolved it.` : `Replied to ${threadId}.`)
			return
		}
		case 'list': {
			await ensureDaemon()
			const { threads } = threadsSchema.parse(await call(project, 'GET', '/threads'))
			const pending = threads.filter((thread) => thread.state !== 'resolved')
			if (pending.length === 0) console.log('No unresolved threads.')
			for (const thread of pending) {
				const first = thread.comments[0]?.body.split('\n')[0] ?? ''
				console.log(`${thread.id}  ${thread.state.padEnd(8)}  ${thread.anchor.url}\n    ${first}`)
			}
			return
		}
		default:
			console.log(USAGE)
			process.exit(subcommand === undefined || subcommand === '--help' ? 0 : 1)
	}
}
