export interface BuildEvent {
	issue?: string
	status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'info'
	message?: string
	at?: string
	data?: Record<string, unknown>
}

const MAX_BUFFER = 500

export class BuildStream {
	private events: BuildEvent[] = []
	private subscribers = new Set<(ev: BuildEvent) => void>()

	append(ev: BuildEvent): BuildEvent {
		const stamped: BuildEvent = { ...ev, at: ev.at ?? new Date().toISOString() }
		this.events.push(stamped)
		if (this.events.length > MAX_BUFFER) {
			this.events.splice(0, this.events.length - MAX_BUFFER)
		}
		for (const fn of this.subscribers) {
			try {
				fn(stamped)
			} catch {
			}
		}
		return stamped
	}

	history(): BuildEvent[] {
		return [...this.events]
	}

	subscribe(fn: (ev: BuildEvent) => void): () => void {
		this.subscribers.add(fn)
		return () => this.subscribers.delete(fn)
	}
}
