// The kit `fabrika app dev` previews an application through, and the types of the seed module it runs first.

import type { AnyContract, DimensionOf } from '../contract/define'
import type { ContractImplementation } from '../implement/implement'
import type { PersonTestCaller, TestCaller } from './caller'
import { bootTestKit, type TestKit, type TestKitOptions } from './kit'
import type { SentInvitation, TestMembership } from './membership'

/** Someone the author clicks through the application as: a person the seed made with `dev.testCaller`. */
export interface DevPersona {
	/** Shown on the picker's card and in the toolbar, unique among the personas: `Petra`. */
	readonly name: string
	/** One short line of who this is: `Staff of the design workspace`. */
	readonly description?: string
	readonly caller: PersonTestCaller
}

/** A page a link holder opens: a link the seed issued through the application's own endpoint. */
export interface DevLink {
	readonly title: string
	readonly description?: string
	/** The URL the application answered, a path of its origin: `/s/#px_…`. */
	readonly url: string
}

/** A scope value the seed made, with the name a person knows it by: `{ value: 'w1', label: 'Design team' }`. */
export interface DevScopeValue {
	readonly value: string
	readonly label: string
}

/** What a seed answers; every part is optional. */
export interface DevSeedResult<C extends AnyContract> {
	readonly personas?: readonly DevPersona[]
	readonly links?: readonly DevLink[]
	/** The values of each dimension the seed made, which the picker offers for a membership role. */
	readonly scopes?: { readonly [D in DimensionOf<C>]?: readonly DevScopeValue[] }
}

/**
 * The default export of `dev/seed.ts`: it receives the application's test kit, the API its tests use, writes through the
 * endpoints, and answers who and what the picker offers.
 */
export type DevSeed<C extends AnyContract> = (dev: TestKit<C>) => Promise<DevSeedResult<C>> | DevSeedResult<C>

export interface DevKit<C extends AnyContract> {
	readonly kit: TestKit<C>
	/** The person `value` is when this kit made it; `undefined` for any other value. */
	personOf(value: unknown): PersonTestCaller | undefined
	/** The roles a caller of this kit holds now: its grants, with what the application assigned and revoked through IAM. */
	membershipsOf(caller: TestCaller): readonly TestMembership[]
	/** The invitation e-mails the stand-in IAM sent, in the order it first sent them. */
	invitations(): readonly SentInvitation[]
}

const isPerson = (caller: TestCaller): caller is PersonTestCaller => caller.kind === 'human' && caller.email !== null

/** The test kit of `app` with its stand-in IAM, and what `fabrika app dev` shows of it. */
export function devKit<C extends AnyContract>(app: ContractImplementation<C>, options: Omit<TestKitOptions, 'membership'> = {}): DevKit<C> {
	const { kit, standIn, callerOf } = bootTestKit(app, options)
	if (standIn === null) {
		throw new Error('a kit without its own membership transport stands in for IAM')
	}
	return Object.freeze({
		kit,
		personOf(value: unknown): PersonTestCaller | undefined {
			const caller = callerOf(value)
			return caller !== undefined && isPerson(caller) ? caller : undefined
		},
		membershipsOf: (caller: TestCaller) => standIn.membershipsOf(caller),
		invitations: () => standIn.invitations(),
	})
}
