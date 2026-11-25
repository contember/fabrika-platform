// Applying one of the provider's CloudFormation stacks (an application environment's, `environment-stack.ts`, or a
// namespace's, `namespace.ts`) and waiting until it serves the rendered template, over `aws/cloudformation.ts`.
//
// UNVERIFIED: that `GetTemplate` answers a JSON template's body as JSON, and the statuses' meaning, follow
// CloudFormation's API reference; none was checked against an account.

import type { JsonValue } from '@fabrika/provider-contract'
import {
	type CloudFormationClient,
	MAX_TEMPLATE_BYTES,
	STACK_STATUSES,
	type StackDescription,
	type StackStatus,
	type StackSummary,
} from './aws/cloudformation'
import { AwsError } from './aws/transport'

/** How often a stack is read while CloudFormation works on it, and how long a caller waits for it. */
export const AWS_STACK_POLL_MS = 10_000
export const AWS_STACK_TIMEOUT_MS = 20 * 60 * 1000

/**
 * A stack CloudFormation is still creating or updating when the caller stops waiting: nothing is wrong with it, and a
 * later call settles it. Every other refusal of `ensureStack` is one only an operator or a new template repairs.
 */
export class AwsStackPending extends Error {
	override readonly name = 'AwsStackPending'
	constructor(readonly stackName: string, message: string) {
		super(message)
	}
}

/** One stack as the provider renders it: its name, its template and its own tags. */
export interface AwsStack {
	readonly stackName: string
	readonly template: JsonValue
	readonly tags: Readonly<Record<string, string>>
}

/** The statuses from which a stack serves: its template is the one last applied. */
export const SETTLED: ReadonlySet<StackStatus> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE'])
/** The statuses CloudFormation leaves by itself. `REVIEW_IN_PROGRESS` (an unexecuted change set) never does. */
export const MOVING: ReadonlySet<StackStatus> = new Set(
	STACK_STATUSES.filter((status) => status.endsWith('_IN_PROGRESS') && status !== 'REVIEW_IN_PROGRESS'),
)

/** A JSON value's text with every object's keys sorted: two documents equal as JSON have one canonical text. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

/** Whether a template body the stack answered is the rendered one as JSON; a body that is not JSON is not. */
function sameTemplate(answered: string, wanted: string): boolean {
	try {
		return canonical(JSON.parse(answered)) === wanted
	} catch {
		return false
	}
}

/** A read of the stack: by name (`null` when none is listed) or by id (`DELETE_COMPLETE` once it is deleted). */
type StackRead = StackSummary | StackDescription | null

/** What a read that may be sent again answered, or `UNREAD` when AWS asked to read again later. */
export const UNREAD = Symbol('unread')
export async function readAgainLater<T>(read: () => Promise<T>): Promise<T | typeof UNREAD> {
	try {
		return await read()
	} catch (error) {
		// A read changes nothing, so a throttle or a lost answer is read again at the next poll, within the deadline.
		if (error instanceof AwsError && error.retryable) return UNREAD
		throw error
	}
}

export interface EnsureStackInput {
	readonly cloudFormation: Pick<CloudFormationClient, 'findStack' | 'describeStack' | 'getTemplate' | 'createStack' | 'updateStack'>
	readonly stack: AwsStack
	readonly signal: AbortSignal
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly log: (line: string) => void
	readonly now?: () => number
	/** A `ClientRequestToken`, one per call sent. */
	readonly newToken?: () => string
}

/**
 * Brings a stack to the rendered template and waits until it serves: creates it when absent, updates it when the
 * template it holds differs, and waits while CloudFormation works. Answers the stack's outputs, read by its id once it
 * serves the template.
 *
 * - The template is compared as JSON (`GetTemplate`'s body parsed, keys in any order), so an unchanged stack is never
 *   updated: a no-op update is refused with a `ValidationError` only its message names, which would fail every later
 *   call. A body that is not JSON is updated.
 * - After a create the stack is read by its id (`describeStack`), which answers `DELETE_COMPLETE` once a failed create
 *   was deleted (`OnFailure=DELETE`), so a create that fails before the first read is reported as failed, not as a
 *   timeout. Absence is decided by `ListStacks` alone (`findStack`).
 * - A read refused for rate or with a lost answer is read again at the next poll; a refused write fails the call.
 * - Refused: a stack still moving when the wait ends (`AwsStackPending`, which a later call settles), a create or
 *   an update of its own that failed, a stack an operator must repair (`*_FAILED`,
 *   `ROLLBACK_COMPLETE`, an unexecuted change set), and a template past `MAX_TEMPLATE_BYTES` (named, not a bare
 *   refusal).
 */
export async function ensureStack(input: EnsureStackInput): Promise<Readonly<Record<string, string>>> {
	const { cloudFormation, stack, signal, sleep, log } = input
	const now = input.now ?? Date.now
	const newToken = input.newToken ?? (() => crypto.randomUUID())
	const body = JSON.stringify(stack.template)
	const name = stack.stackName
	const bytes = new TextEncoder().encode(body).byteLength
	if (bytes > MAX_TEMPLATE_BYTES) {
		throw new Error(`aws: the stack ${name}'s template is ${bytes} bytes, past the ${MAX_TEMPLATE_BYTES} CloudFormation takes inline`)
	}
	const wanted = canonical(stack.template)
	const giveUpAt = now() + AWS_STACK_TIMEOUT_MS
	let sent: 'create' | 'update' | null = null
	// The stack's id once a create answered it or a read listed it: from then on it is read by its id.
	let stackId: string | null = null
	for (;;) {
		signal.throwIfAborted()
		const id: string | null = stackId
		const found: StackRead | typeof UNREAD = await readAgainLater<StackRead>(() =>
			id === null ? cloudFormation.findStack(name, signal) : cloudFormation.describeStack(id, signal)
		)
		if (found === UNREAD) {
			// Read again at the next poll.
		} else if (found === null || found.status === 'DELETE_COMPLETE') {
			if (sent === 'create' && found !== null) {
				throw new Error(`aws: creating the stack ${name} failed and CloudFormation deleted it; its events say why`)
			}
			// No stack (or the one this call followed is gone): create one. Another creator that won the name is followed
			// from the next read on.
			stackId = null
			try {
				stackId = await cloudFormation.createStack({ name, templateBody: body, tags: stack.tags, token: newToken() }, signal)
				sent = 'create'
				log(`aws: creating the stack ${name}`)
			} catch (error) {
				if (!(error instanceof AwsError && error.code === 'AlreadyExistsException')) throw error
				sent = null
			}
		} else {
			stackId = found.stackId
			if (SETTLED.has(found.status)) {
				if (found.status === 'UPDATE_ROLLBACK_COMPLETE' && sent === 'update') {
					throw new Error(`aws: updating the stack ${name} failed and CloudFormation rolled it back; its events say why`)
				}
				const answered = await readAgainLater(() => cloudFormation.getTemplate(name, signal))
				if (answered !== UNREAD) {
					if (sameTemplate(answered, wanted)) {
						// A read by name lists no outputs: the stack is read by its id for them.
						const settled = found
						const described = 'outputs' in settled ? settled : await readAgainLater(() => cloudFormation.describeStack(settled.stackId, signal))
						if (described !== UNREAD && described.status !== 'DELETE_COMPLETE' && SETTLED.has(described.status)) {
							log(`aws: the stack ${name} is current`)
							return described.outputs
						}
						// Read again at the next poll: the read failed, or the stack moved in between.
						if (now() >= giveUpAt) throw new AwsStackPending(name, `aws: the stack ${name} did not settle within ${AWS_STACK_TIMEOUT_MS / 60_000} minutes`)
						await sleep(AWS_STACK_POLL_MS, signal)
						continue
					}
					if (sent === 'update') throw new Error(`aws: the stack ${name} holds another template than the update sent`)
					await cloudFormation.updateStack({ name, templateBody: body, token: newToken() }, signal)
					sent = 'update'
					log(`aws: updating the stack ${name}`)
				}
			} else if (!MOVING.has(found.status)) {
				throw new Error(`aws: the stack ${name} is ${found.status}; an operator must repair or delete it before a deploy`)
			}
		}
		if (now() >= giveUpAt) throw new AwsStackPending(name, `aws: the stack ${name} did not settle within ${AWS_STACK_TIMEOUT_MS / 60_000} minutes`)
		await sleep(AWS_STACK_POLL_MS, signal)
	}
}

/**
 * The outputs of a stack that already serves, without changing it: `null` when no stack of the name exists, and an
 * error naming its status when it does not serve (being created, updated, or broken). For a stack another call applies,
 * which this caller only reads (an environment's deploy reading its namespace's stack).
 */
export async function readStackOutputs(
	cloudFormation: Pick<CloudFormationClient, 'findStack' | 'describeStack'>,
	name: string,
	signal: AbortSignal,
): Promise<Readonly<Record<string, string>> | null> {
	const found = await cloudFormation.findStack(name, signal)
	if (found === null) return null
	const described = await cloudFormation.describeStack(found.stackId, signal)
	if (described.status === 'DELETE_COMPLETE') return null
	if (MOVING.has(described.status)) {
		throw new AwsStackPending(
			name,
			`aws: the stack ${name} is ${described.status}: CloudFormation is still working on it; run this again once it serves`,
		)
	}
	if (!SETTLED.has(described.status)) throw new Error(`aws: the stack ${name} is ${described.status}; an operator must repair or delete it`)
	return described.outputs
}
