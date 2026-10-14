// The kit `fabrika app dev` previews an application through, and the types of the seed module it runs first.

import type { AnyContract, DimensionOf } from '../contract/define'
import type { ContractImplementation } from '../implement/implement'
import type { PersonTestCaller, TestCaller } from './caller'
import { passingChallenge, TURNSTILE_TEST_TOKEN } from './challenge'
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

/** The origin `fabrika app dev` captures every request to: an outside provider's stand-in, named by its path. */
export const DEV_OUTBOX_ORIGIN = 'https://outbox.invalid'

/** A request the application sent to `DEV_OUTBOX_ORIGIN` under `fabrika app dev`: its body, never its headers. */
export interface DevOutboxMessage {
	readonly id: number
	readonly method: string
	/** The path it was sent to: `/mail`. */
	readonly path: string
	readonly contentType: string | null
	readonly body: string
}

/** What `fabrika app dev` stands in for outside the application, for the seed to read. */
export interface DevOutside {
	/** Every request sent to `DEV_OUTBOX_ORIGIN` so far, oldest first. */
	outbox(): readonly DevOutboxMessage[]
}

/**
 * The default export of `dev/seed.ts`: it receives the application's test kit, the API its tests use, writes through the
 * endpoints, and answers who and what the picker offers. `outside` reads what the application sent to the dev outbox.
 */
export type DevSeed<C extends AnyContract> = (dev: TestKit<C>, outside: DevOutside) => Promise<DevSeedResult<C>> | DevSeedResult<C>

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

/**
 * The test kit of `app` with its stand-in IAM, and what `fabrika app dev` shows of it. A form's challenge passes
 * (`passingChallenge`) unless `options.challengeFetch` answers it, and admits the test widget's token
 * (`TURNSTILE_TEST_TOKEN`) at every submission; any other token is single use, as deployed.
 */
export function devKit<C extends AnyContract>(app: ContractImplementation<C>, options: Omit<TestKitOptions, 'membership'> = {}): DevKit<C> {
	const { kit, standIn, callerOf } = bootTestKit(app, { challengeFetch: passingChallenge, ...options }, {
		repeatableChallengeToken: TURNSTILE_TEST_TOKEN,
	})
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
