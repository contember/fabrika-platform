// The launcher's view of output: every line of the application and of the commands it runs is forwarded to its own
// stream, as Zerops' runtime log reads it, and the newest lines are kept to report. Secret values never reach either.

import { DEV_REPORT_MAX_LINE_CHARACTERS, type DevLogLine } from './wire.js'

export type OutputStream = DevLogLine['stream']

export interface OutputSink {
	write(stream: OutputStream, line: string): void
}

/** The launcher process's own stdout and stderr. */
export const processOutput: OutputSink = {
	write(stream, line) {
		;(stream === 'stdout' ? process.stdout : process.stderr).write(`${line}\n`)
	},
}

/**
 * The newest `capacity` lines, numbered from 0 since the launcher started, with every known secret value replaced. A
 * mark starts the lines a report carries: those of the newest sync or reset, and the output after it.
 */
export class OutputRing {
	private readonly lines: DevLogLine[] = []
	private next = 0
	private marked = 0

	constructor(private readonly capacity: number, private readonly secrets: readonly string[], private readonly sink: OutputSink) {}

	push(stream: OutputStream, text: string): void {
		const line = this.redact(text)
		this.sink.write(stream, line)
		this.lines.push({ n: this.next, stream, text: line.slice(0, DEV_REPORT_MAX_LINE_CHARACTERS) })
		this.next += 1
		if (this.lines.length > this.capacity) this.lines.shift()
	}

	/** Report from the next line on: the lines before it belong to an older head. */
	mark(): void {
		this.marked = this.next
	}

	/** The newest `count` lines since the mark, oldest first. */
	tail(count: number): DevLogLine[] {
		const since = this.lines.filter((line) => line.n >= this.marked)
		return since.slice(Math.max(0, since.length - count))
	}

	private redact(text: string): string {
		let line = text
		for (const secret of this.secrets) line = line.replaceAll(secret, '[redacted]')
		return line
	}
}

/** Feed `stream` to `onLine` one line at a time; a last line without a newline is fed when the stream ends. */
export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
	const decoder = new TextDecoder()
	const reader = stream.getReader()
	let pending = ''
	for (let read = await reader.read(); !read.done; read = await reader.read()) {
		pending += decoder.decode(read.value, { stream: true })
		let end = pending.indexOf('\n')
		while (end !== -1) {
			onLine(pending.slice(0, end).replace(/\r$/, ''))
			pending = pending.slice(end + 1)
			end = pending.indexOf('\n')
		}
	}
	pending += decoder.decode()
	if (pending !== '') onLine(pending)
}
