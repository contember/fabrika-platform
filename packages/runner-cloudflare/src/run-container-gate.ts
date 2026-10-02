export interface CancellationMarker {
	read(): Promise<boolean>
	write(): Promise<void>
}

/** A cancellation tombstone survives DO eviction; the queue drains effects already admitted. */
export class RunContainerGate {
	private tail: Promise<void> = Promise.resolve()

	constructor(private readonly marker: CancellationMarker) {}

	private enqueue<T>(effect: () => Promise<T>): Promise<T> {
		const result = this.tail.then(effect)
		this.tail = result.then(() => {}, () => {})
		return result
	}

	run<T>(effect: () => Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			if (await this.marker.read()) throw new Error('runner: run cancelled')
			return effect()
		})
	}

	async cancel(destroy: () => Promise<void>): Promise<void> {
		await this.marker.write()
		await this.enqueue(destroy)
	}

	recover(dispatched: () => Promise<boolean>, destroy: () => Promise<void>): Promise<'running' | 'failed'> {
		return this.enqueue(async () => {
			if (await dispatched()) return 'running'
			await this.marker.write()
			await destroy()
			return 'failed'
		})
	}
}
