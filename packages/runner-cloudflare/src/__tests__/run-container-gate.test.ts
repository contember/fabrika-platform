import { expect, test } from 'bun:test'
import { RunContainerGate } from '../run-container-gate'

function fixture() {
	let cancelled = false
	const marker = {
		read: async () => cancelled,
		write: async () => {
			cancelled = true
		},
	}
	return { marker, gate: new RunContainerGate(marker) }
}

test('recovery fences never-dispatched work before allowing terminal settlement', async () => {
	const { gate, marker } = fixture()
	let destroyed = false
	expect(
		await gate.recover(async () => false, async () => {
			destroyed = true
		}),
	).toBe('failed')
	expect(destroyed).toBe(true)
	await expect(new RunContainerGate(marker).run(async () => {})).rejects.toThrow('run cancelled')
})

test('recovery leaves dispatched work to its armed backstop and never treats a destroy failure as settlement', async () => {
	const { gate } = fixture()
	let destroys = 0
	expect(
		await gate.recover(async () => true, async () => {
			destroys++
		}),
	).toBe('running')
	expect(destroys).toBe(0)
	await expect(gate.recover(async () => false, async () => {
		throw new Error('destroy failed')
	})).rejects.toThrow('destroy failed')
	await expect(gate.run(async () => {})).rejects.toThrow('run cancelled')
})

test('recovery after a failed startup fences a delayed dispatch', async () => {
	const { gate } = fixture()
	await expect(gate.run(async () => {
		throw new Error('boot failed')
	})).rejects.toThrow('boot failed')
	expect(await gate.recover(async () => false, async () => {})).toBe('failed')
	await expect(gate.run(async () => {})).rejects.toThrow('run cancelled')
})

test('failed destruction rejects settlement and preserves the cancellation tombstone across eviction', async () => {
	const { marker, gate } = fixture()
	await expect(gate.cancel(async () => {
		throw new Error('stop unavailable')
	})).rejects.toThrow('stop unavailable')
	const restarted = new RunContainerGate(marker)
	let started = false
	await expect(restarted.run(async () => {
		started = true
	})).rejects.toThrow('run cancelled')
	expect(started).toBe(false)
	let destroyed = false
	await restarted.cancel(async () => {
		destroyed = true
	})
	expect(destroyed).toBe(true)
})

test('cancel before delayed startup prevents both startup and dispatch', async () => {
	const { gate } = fixture()
	const authenticated = Promise.withResolvers<void>()
	const effects: string[] = []
	const start = authenticated.promise.then(() =>
		gate.run(async () => {
			effects.push('start')
		})
	)
	await gate.cancel(async () => {
		effects.push('destroy')
	})
	authenticated.resolve()
	await expect(start).rejects.toThrow('run cancelled')
	await expect(gate.run(async () => {
		effects.push('dispatch')
	})).rejects.toThrow('run cancelled')
	expect(effects).toEqual(['destroy'])
})

test('cancellation drains an admitted startup before destruction, refusing later dispatch', async () => {
	const { gate } = fixture()
	const entered = Promise.withResolvers<void>()
	const booted = Promise.withResolvers<void>()
	const effects: string[] = []
	const starting = gate.run(async () => {
		entered.resolve()
		await booted.promise
		effects.push('started')
	})
	await entered.promise
	const cancelling = gate.cancel(async () => {
		effects.push('destroyed')
	})
	await Promise.resolve()
	expect(effects).toEqual([])
	booted.resolve()
	await Promise.all([starting, cancelling])
	await expect(gate.run(async () => {
		effects.push('dispatch')
	})).rejects.toThrow('run cancelled')
	expect(effects).toEqual(['started', 'destroyed'])
})
