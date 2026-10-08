import type { CompiledQuery } from 'kysely'
import type { Ref, Within } from '../../capability'
import { Database } from '../../database'
import { TestAuthority } from './authority'
import { RecordingDialect } from './recording-dialect'
import { defineStores } from './stores'

/** Calls a method by name with arguments the types would refuse: how a defeated type system reaches the layer. */
export function call(target: unknown, name: string, ...args: unknown[]): unknown {
	if (typeof target !== 'object' || target === null) {
		throw new TypeError(`cannot call ${name} on ${String(target)}`)
	}
	const method: unknown = Reflect.get(target, name)
	if (typeof method !== 'function') {
		throw new TypeError(`${name} is not a function`)
	}
	return Reflect.apply(method, target, args)
}

export interface Outcome {
	readonly error: Error | undefined
	readonly statements: readonly CompiledQuery[]
}

export function recordingLayer() {
	const dialect = new RecordingDialect()
	const capabilities = new TestAuthority()
	const stores = defineStores({ database: Database.fromDialect(dialect), capabilities })
	const raw = {
		notes: stores.defineStore('notes', (t) => ({ t })).t,
		organizations: stores.defineStore('organizations', (t) => ({ t })).t,
		workspaces: stores.defineStore('workspaces', (t) => ({ t })).t,
		secrets: stores.defineStore('secrets', (t) => ({ t })).t,
		comments: stores.defineChildStore('note_comments', (t) => ({ t })).t,
	}

	async function attempt(action: () => unknown): Promise<Outcome> {
		const before = dialect.log.length
		let error: Error | undefined
		try {
			await action()
		} catch (caught) {
			error = caught instanceof Error ? caught : new Error(String(caught))
		}
		return { error, statements: dialect.log.slice(before) }
	}

	const noteRef = <const A extends string>(action: A, id = 'n1', workspace = 'w1', organization = 'o1'): Ref<'note', A> =>
		capabilities.ref('note', action, id, { workspace, organization })
	const workspaceRef = <const A extends string>(action: A, id = 'w1', organization = 'o1'): Ref<'workspace', A> =>
		capabilities.ref('workspace', action, id, { organization })
	const within = <const A extends string>(action: A, values: readonly string[] | 'all' = ['w1']): Within<'workspace', A> =>
		capabilities.within('workspace', action, values)

	return { dialect, capabilities, stores, raw, attempt, noteRef, workspaceRef, within }
}
