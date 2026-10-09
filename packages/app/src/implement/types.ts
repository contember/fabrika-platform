// The handler types `implement` checks against the contract: one handler per declared procedure, nothing else, each
// with the context its access form grants and returning only the fields its output declares.

import type { z } from 'zod/v4'
import type { SurfaceSection } from '../contract/declaration'
import type { InputOf, LinkMount, MemberAccess, Procedure, RoleOf, RpcMount, Schema, WebhookMount } from '../contract/define'
import type { Ref, Within } from './capability'
import type { LinkIssuing, MemberManagement } from './membership'
import type { LinkHolder, PrincipalOf } from './principal'
import type { WebhookDelivery, WebhookPrincipal } from './webhook'

/** What every handler gets: who called, and this request's id. */
export interface RequestContext<P> {
	readonly principal: P
	readonly requestId: string
}

/** The capability an access form hands. `{ member: true }` hands none. */
export type AccessContext<Acc> = Acc extends MemberAccess ? unknown
	: Acc extends { readonly action: infer A extends string; readonly over: infer D extends string } ? { readonly within: Within<D, A> }
	: Acc extends { readonly action: infer A extends string; readonly in: infer D extends string } ? { readonly target: Ref<D, A> }
	: Acc extends { readonly action: infer A extends string; readonly on: infer D extends string } ? { readonly target: Ref<D, A> }
	: Acc extends { readonly action: infer A extends string; readonly creates: infer D extends string } ? { readonly created: Ref<D, A> }
	: never

type DimensionsOf<C> = C extends { readonly dimensions: infer Dims } ? Dims : never

/** The dimension and action of an access form that hands a `Ref` of an existing object. */
type TargetOf<Acc> = Acc extends { readonly action: infer A extends string; readonly in: infer D extends string } ? readonly [D, A]
	: Acc extends { readonly action: infer A extends string; readonly on: infer D extends string } ? readonly [D, A]
	: never

/** `ctx.members`, only where the action is the dimension's `members.manage` (the framework document, section 6). */
type MembersContext<C, Acc> = TargetOf<Acc> extends readonly [infer D extends string, infer A extends string]
	? DimensionsOf<C>[D & keyof DimensionsOf<C>] extends { readonly members: { readonly manage: A } }
		? { readonly members: MemberManagement<D, A, RoleOf<C>> }
	: unknown
	: unknown

/** The link mounts whose dimension and issuing action are `D` and `A`. */
type IssuingMounts<C, D extends string, A extends string> =
	& {
		[M in keyof SurfaceOf<C>]: SurfaceOf<C>[M] extends { readonly kind: 'link'; readonly dimension: D; readonly issuedBy: A } ? M : never
	}[keyof SurfaceOf<C>]
	& string

/** `ctx.links`, only where the `Ref` carries a link mount's issuing action for its dimension. */
type LinksContext<C, Acc> = TargetOf<Acc> extends readonly [infer D extends string, infer A extends string]
	? [IssuingMounts<C, D, A>] extends [never] ? unknown : { readonly links: LinkIssuing<D, A, IssuingMounts<C, D, A>> }
	: unknown

/** What a procedure's context carries for its access form in this contract. */
export type ContractContext<C, Acc> = AccessContext<Acc> & MembersContext<C, Acc> & LinksContext<C, Acc>

/** The input without the `from` field: the only copy of that id a handler has is the checked capability. */
export type HandlerInput<I, Acc> = Acc extends { readonly from: infer F extends string }
	? { readonly [K in keyof InputOf<I> as K extends F ? never : K]: InputOf<I>[K] }
	: InputOf<I>

export type Handler<In, Ctx, O extends Schema> = (args: { readonly input: In; readonly ctx: Ctx }) => z.input<O> | Promise<z.input<O>>

type RpcHandlers<C, P, T> = {
	readonly [K in keyof T]: T[K] extends Procedure<'query' | 'mutation', infer I, infer O, infer Acc>
		? Handler<HandlerInput<I, Acc>, RequestContext<P> & ContractContext<C, Acc>, O>
		: RpcHandlers<C, P, T[K]>
}

/** A link procedure acts on the object its key is bound to. */
type LinkHandlers<D extends string, T> = {
	readonly [K in keyof T]: T[K] extends Procedure<'query' | 'mutation', infer I, infer O, { readonly action: infer A extends string }>
		? Handler<InputOf<I>, RequestContext<LinkHolder> & { readonly target: Ref<D, A> }, O>
		: LinkHandlers<D, T[K]>
}

/**
 * A delivery's handler: the declared input, a `Ref` of the bound value for each declared action, and the delivery's
 * stable key. It runs at least once per delivery: a failed run is run again on GitHub's redelivery.
 */
export type WebhookHandler<B extends string, Acts extends string, I> = (args: {
	readonly input: z.output<I>
	readonly ctx: RequestContext<WebhookPrincipal> & { readonly refs: { readonly [A in Acts]: Ref<B, A> }; readonly delivery: WebhookDelivery }
}) => void | Promise<void>

type MountHandlers<C, M> = M extends RpcMount<infer Callers, infer T> ? RpcHandlers<C, PrincipalOf<Callers[number]>, T>
	: M extends LinkMount<infer D, string, string, infer T> ? LinkHandlers<D, T>
	: M extends WebhookMount<infer B, infer Acts, infer I> ? WebhookHandler<B, Acts, I>
	: never

type ServedMount<M> = M extends { readonly kind: 'rpc' | 'link' | 'webhook' } ? true : false

type SurfaceOf<C> = C extends { readonly surface: infer S } ? S : never

/** One handler tree per procedure mount and one handler per webhook, keyed like the contract. */
export type HandlersOf<C> = {
	readonly [M in keyof SurfaceOf<C> as M extends SurfaceSection ? never : ServedMount<SurfaceOf<C>[M]> extends true ? M : never]: MountHandlers<
		C,
		SurfaceOf<C>[M]
	>
}

// ── Exactness: no handler outside the contract, no field outside the declared output ────────────

/** An `any` comes from an error elsewhere in the handler; reporting it here too would only add noise. */
type IsAny<T> = 0 extends 1 & T ? true : false

/** Fields of `R` that the output `O` does not declare. When `O` is a union, a value that fits one branch has none. */
type ExtraKeys<R, O> = IsAny<R> extends true ? never
	: true extends (O extends unknown ? ([ExtraKeysOf<R, O>] extends [never] ? true : false) : never) ? never
	: ExtraKeysOf<R, O>

type ExtraKeysOf<R, O> = R extends readonly (infer RE)[] ? (O extends readonly (infer OE)[] ? ExtraKeys<RE, OE> : never)
	: R extends object ? O extends object ? Exclude<keyof R, keyof O> | { [Q in keyof R & keyof O]: ExtraKeys<R[Q], O[Q]> }[keyof R & keyof O]
		: never
	: never

type Returned<F> = F extends (args: never) => infer R ? Awaited<R> : never

type Undeclared<F, Expected> = ExtraKeys<Returned<F>, Returned<Expected>>

/** No undeclared field, or a field whose type is an error reported where it arose. */
type NoneOrError<U> = [U] extends [never] ? true : IsAny<U>

type ExactTree<H, E, Path extends string> = {
	readonly [K in keyof H]: K extends keyof E ? E[K] extends (args: never) => unknown ? NoneOrError<Undeclared<H[K], E[K]>> extends true ? H[K]
			: {
				readonly [_ in `handler '${Path}${K & string}' returns fields the contract output does not declare. Return only declared fields`]: Undeclared<
					H[K],
					E[K]
				>
			}
		: ExactTree<H[K], E[K], `${Path}${K & string}.`>
		: `'${Path}${K & string}' is not in the contract. Declare the endpoint in fabrika.contract.ts first.`
}

type KindOf<M> = M extends { readonly kind: infer K extends string } ? K : 'section'

export type ExactHandlers<H, C> = {
	readonly [M in keyof H]: M extends keyof HandlersOf<C> ? HandlersOf<C>[M] extends (args: never) => unknown ? H[M]
		: ExactTree<H[M], HandlersOf<C>[M], `${M & string}.`>
		: M extends keyof SurfaceOf<C> ? `'${M & string}' is a ${KindOf<SurfaceOf<C>[M]>} mount; it takes no handler. Remove it from handlers.`
		: `'${M & string}' is not in the contract. Declare the mount in fabrika.contract.ts first.`
}
