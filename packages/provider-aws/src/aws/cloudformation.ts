// The CloudFormation calls the provider makes, over the query protocol (`query.ts`): find a stack by name, read the
// template it holds, create and update one. Nothing here reads an error's message, so a stack's absence is decided
// from `ListStacks` (which lists every stack but deleted ones), never from a `DescribeStacks` refusal, whose
// `ValidationError` only its message tells apart from a malformed call.
//
// - `createStack` sends `OnFailure=DELETE`: a create that fails leaves no `ROLLBACK_COMPLETE` stack behind that would
//   block the next create of the same name, and a `ClientRequestToken`, so a lost answer repeated creates nothing more.
// - `CAPABILITY_NAMED_IAM`: the environment stack names its roles.
// - A status CloudFormation may add later is `invalid_answer`, never a guess.
// - `describeStack` reads one stack by its id (its ARN), which keeps answering `DELETE_COMPLETE` after a delete: how a
//   caller tells a create of its own that failed (and was deleted) from a stack `ListStacks` does not show yet. It also
//   reads the stack's outputs: what a template creates under a name AWS chooses (a security group's id).
//
// UNVERIFIED: the actions, their parameters, the answers' element names, `ListStacks`' filter and the statuses follow
// CloudFormation's API reference; none was checked against an account.

import { awsQueryClient, CLOUDFORMATION } from './query'
import { type AwsClientOptions, AwsError } from './transport'
import { xmlChildren, type XmlElement, xmlOptional, xmlText } from './xml'

/** The values as a list whose element type is their union. */
const literals = <T extends string>(...values: T[]): readonly T[] => values

/** Every status a stack can be in, but `DELETE_COMPLETE`, which `findStack` never lists. */
export const STACK_STATUSES = literals(
	'CREATE_IN_PROGRESS',
	'CREATE_FAILED',
	'CREATE_COMPLETE',
	'ROLLBACK_IN_PROGRESS',
	'ROLLBACK_FAILED',
	'ROLLBACK_COMPLETE',
	'DELETE_IN_PROGRESS',
	'DELETE_FAILED',
	'UPDATE_IN_PROGRESS',
	'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
	'UPDATE_COMPLETE',
	'UPDATE_FAILED',
	'UPDATE_ROLLBACK_IN_PROGRESS',
	'UPDATE_ROLLBACK_FAILED',
	'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
	'UPDATE_ROLLBACK_COMPLETE',
	'REVIEW_IN_PROGRESS',
	'IMPORT_IN_PROGRESS',
	'IMPORT_COMPLETE',
	'IMPORT_ROLLBACK_IN_PROGRESS',
	'IMPORT_ROLLBACK_FAILED',
	'IMPORT_ROLLBACK_COMPLETE',
)

export type StackStatus = (typeof STACK_STATUSES)[number]

/** The most pages `findStack` reads: ListStacks answers up to 100 summaries a page. */
const MAX_PAGES = 50
/** A stack's name: a letter, then letters, digits and hyphens, at most 128. */
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/
/** A stack's id, an ARN. */
const STACK_ID = /^arn:aws(?:-[a-z]{1,10}){0,2}:cloudformation:[a-z0-9-]{1,32}:\d{12}:stack\/[A-Za-z][A-Za-z0-9-]{0,127}\/[A-Za-z0-9-]{1,64}$/
/** A request token: what CloudFormation takes as `ClientRequestToken`. */
const REQUEST_TOKEN = /^[a-zA-Z0-9][-a-zA-Z0-9]{0,127}$/
/** The largest template body CloudFormation takes inline. */
export const MAX_TEMPLATE_BYTES = 51_200

export interface StackSummary {
	readonly stackId: string
	readonly status: StackStatus
}

/** A stack read by its id: its status and its outputs by key (none while it is created or once it is deleted). */
export interface StackDescription {
	readonly stackId: string
	readonly status: StackStatus | 'DELETE_COMPLETE'
	readonly outputs: Readonly<Record<string, string>>
}

/** The most outputs a template declares (CloudFormation's quota), and an output key's form. */
const MAX_OUTPUTS = 200
const OUTPUT_KEY = /^[A-Za-z0-9]{1,255}$/

export interface CloudFormationClient {
	/** The live stack named `name`, `null` when there is none (or only deleted ones). */
	findStack(name: string, signal?: AbortSignal): Promise<StackSummary | null>
	/**
	 * The stack of `stackId` (an ARN): for a deleted stack `DELETE_COMPLETE`, because a read by id keeps answering one,
	 * so a stack this caller created and CloudFormation deleted is told apart from one not listed yet.
	 */
	describeStack(stackId: string, signal?: AbortSignal): Promise<StackDescription>
	/** The template body the stack was last created or updated with. */
	getTemplate(name: string, signal?: AbortSignal): Promise<string>
	/** Starts creating `name`; answers its id. */
	createStack(
		input: { readonly name: string; readonly templateBody: string; readonly tags: Readonly<Record<string, string>>; readonly token: string },
		signal?: AbortSignal,
	): Promise<string>
	/** Starts updating `name` to `templateBody`; answers its id. A body equal to the stack's is the caller's to skip. */
	updateStack(input: { readonly name: string; readonly templateBody: string; readonly token: string }, signal?: AbortSignal): Promise<string>
}

const isStatus = (value: string): value is StackStatus => STACK_STATUSES.some((status) => status === value)

/** Refuses an input this module cannot send before anything is sent; the error carries the code alone. */
function refuse(operation: string): never {
	throw new AwsError(operation, 'invalid_request', 0, null, false)
}

function checkName(operation: string, name: string): void {
	if (!STACK_NAME.test(name)) refuse(operation)
}

function checkBody(operation: string, body: string): void {
	const bytes = new TextEncoder().encode(body).byteLength
	if (bytes === 0 || bytes > MAX_TEMPLATE_BYTES) refuse(operation)
}

/** The stack id an answer carries, of the expected form. */
function stackIdOf(result: XmlElement | null): string {
	const id = result === null ? null : xmlText(result, 'StackId')
	if (id === null || !STACK_ID.test(id)) throw new Error('no stack id')
	return id
}

export function cloudFormationClient(options: AwsClientOptions): CloudFormationClient {
	const query = awsQueryClient(CLOUDFORMATION, options)
	const live: Record<string, string> = {}
	STACK_STATUSES.forEach((status, index) => {
		live[`StackStatusFilter.member.${index + 1}`] = status
	})

	return {
		async findStack(name, signal) {
			checkName('ListStacks', name)
			let next: string | null = null
			const found: StackSummary[] = []
			for (let page = 0; page < MAX_PAGES; page += 1) {
				const answer: { readonly summaries: readonly StackSummary[]; readonly next: string | null } = await query.call(
					'ListStacks',
					{ ...live, ...(next === null ? {} : { NextToken: next }) },
					(result) => {
						if (result === null) return { summaries: [], next: null }
						const summaries = xmlOptional(result, 'StackSummaries')
						const members = summaries === null ? [] : xmlChildren(summaries, 'member')
						return {
							summaries: members.filter((member) => xmlText(member, 'StackName') === name).map((member) => {
								const status = xmlText(member, 'StackStatus') ?? ''
								const stackId = xmlText(member, 'StackId') ?? ''
								if (!isStatus(status) || !STACK_ID.test(stackId)) throw new Error('a summary of another form')
								return { stackId, status }
							}),
							next: xmlText(result, 'NextToken'),
						}
					},
					signal,
				)
				found.push(...answer.summaries)
				if (answer.next === null || answer.next === '') {
					// One live stack holds a name; two would be an answer this client cannot read.
					if (found.length > 1) throw new AwsError('ListStacks', 'invalid_answer', 200, null, false)
					return found[0] ?? null
				}
				next = answer.next
			}
			throw new AwsError('ListStacks', 'too_many_pages', 200, null, false)
		},

		async describeStack(stackId, signal) {
			if (!STACK_ID.test(stackId)) refuse('DescribeStacks')
			return query.call('DescribeStacks', { StackName: stackId }, (result) => {
				const stacks = result === null ? null : xmlOptional(result, 'Stacks')
				const members = stacks === null ? [] : xmlChildren(stacks, 'member')
				const [only, ...more] = members
				if (only === undefined || more.length > 0) throw new Error('not one stack')
				const status = xmlText(only, 'StackStatus') ?? ''
				// An answer about another stack is no answer about this one.
				if (xmlText(only, 'StackId') !== stackId) throw new Error('another stack')
				if (status !== 'DELETE_COMPLETE' && !isStatus(status)) throw new Error('a status of another form')
				const listed = xmlOptional(only, 'Outputs')
				const entries = listed === null ? [] : xmlChildren(listed, 'member')
				if (entries.length > MAX_OUTPUTS) throw new Error('more outputs than a template declares')
				const outputs: Record<string, string> = {}
				for (const entry of entries) {
					const key = xmlText(entry, 'OutputKey') ?? ''
					// A key twice is an answer this client cannot read.
					if (!OUTPUT_KEY.test(key) || key in outputs) throw new Error('an output of another form')
					outputs[key] = xmlText(entry, 'OutputValue') ?? ''
				}
				return { stackId, status, outputs }
			}, signal)
		},

		async getTemplate(name, signal) {
			checkName('GetTemplate', name)
			return query.call('GetTemplate', { StackName: name, TemplateStage: 'Original' }, (result) => {
				const body = result === null ? null : xmlText(result, 'TemplateBody')
				if (body === null) throw new Error('no template body')
				return body
			}, signal)
		},

		async createStack(input, signal) {
			checkName('CreateStack', input.name)
			checkBody('CreateStack', input.templateBody)
			if (!REQUEST_TOKEN.test(input.token)) refuse('CreateStack')
			const tags: Record<string, string> = {}
			Object.entries(input.tags).forEach(([key, value], index) => {
				tags[`Tags.member.${index + 1}.Key`] = key
				tags[`Tags.member.${index + 1}.Value`] = value
			})
			return query.call(
				'CreateStack',
				{
					StackName: input.name,
					TemplateBody: input.templateBody,
					'Capabilities.member.1': 'CAPABILITY_NAMED_IAM',
					OnFailure: 'DELETE',
					ClientRequestToken: input.token,
					...tags,
				},
				stackIdOf,
				signal,
			)
		},

		async updateStack(input, signal) {
			checkName('UpdateStack', input.name)
			checkBody('UpdateStack', input.templateBody)
			if (!REQUEST_TOKEN.test(input.token)) refuse('UpdateStack')
			return query.call(
				'UpdateStack',
				{ StackName: input.name, TemplateBody: input.templateBody, 'Capabilities.member.1': 'CAPABILITY_NAMED_IAM', ClientRequestToken: input.token },
				stackIdOf,
				signal,
			)
		},
	}
}
