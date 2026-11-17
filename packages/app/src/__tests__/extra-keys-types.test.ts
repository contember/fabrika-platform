// Exactness of a handler's output over unions of objects: each member the handler returns is paired with the output
// on its own. The type assertions are checked by the repository typecheck; the test pins what projection does with
// the optional `undefined` keys that the types ignore.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { ExactReturn } from '../contract/group'
import { project } from '../implement/project'
import type { ExtraKeys } from '../implement/types'

type Equals<TLeft, TRight> = [TLeft] extends [TRight] ? ([TRight] extends [TLeft] ? true : false) : false
type Expect<TValue extends true> = TValue

const Note = z.strictObject({ kind: z.literal('note'), title: z.string() })
const Task = z.strictObject({ kind: z.literal('task'), done: z.boolean() })
const Item = z.union([Note, Task])
const Items = z.array(Item)
const Nested = z.strictObject({ first: Item, all: z.array(z.strictObject({ item: Item })) })

type NoteValue = { readonly kind: 'note'; readonly title: string }
type TaskValue = { readonly kind: 'task'; readonly done: boolean }
type ItemValue = NoteValue | TaskValue
type Handler<R> = () => Promise<R>
type Exact<R, O extends z.ZodType> = ExactReturn<Handler<R>, O, 'exact'>
type Refused<T> = [T] extends ['exact'] ? false : true

// An exact union return passes alone, in an array and nested.
type _Alone = Expect<Equals<Exact<ItemValue, typeof Item>, 'exact'>>
type _InArray = Expect<Equals<Exact<ItemValue[], typeof Items>, 'exact'>>
type _Nested = Expect<Equals<Exact<{ first: ItemValue; all: { item: ItemValue }[] }, typeof Nested>, 'exact'>>
type _OneMember = Expect<Equals<Exact<TaskValue, typeof Item>, 'exact'>>
type _Keys = Expect<Equals<ExtraKeys<ItemValue, ItemValue>, never>>

// TypeScript widens object literals of different shapes with optional `undefined` keys; they hold no value.
const literals = (done: boolean) => [{ kind: 'note' as const, title: 'a' }, { kind: 'task' as const, done }]
const conditional = (done: boolean) => (done ? { kind: 'task' as const, done } : { kind: 'note' as const, title: 'a' })
type _WidenedArray = Expect<Equals<ExactReturn<typeof literals, typeof Items, 'exact'>, 'exact'>>
type _WidenedConditional = Expect<Equals<ExactReturn<typeof conditional, typeof Item, 'exact'>, 'exact'>>

// An extra field is still refused, on one member, in an array and nested; so is a member no branch declares. A member
// that fits no branch is reported with its extra fields against every branch.
type WithSecret = NoteValue & { readonly secret: string }
type _ExtraField = Expect<Equals<ExtraKeys<WithSecret | TaskValue, ItemValue>, 'secret' | 'title'>>
type _ExtraFieldInArray = Expect<Refused<Exact<(WithSecret | TaskValue)[], typeof Items>>>
type _ExtraFieldNested = Expect<Equals<ExtraKeys<{ all: { item: TaskValue | WithSecret }[] }, z.input<typeof Nested>>, 'secret' | 'title'>>
type _ExtraFieldRefused = Expect<Refused<Exact<WithSecret | TaskValue, typeof Item>>>
type Extra = { readonly kind: 'note'; readonly title: string; readonly done: boolean }
type _ExtraMember = Expect<Equals<ExtraKeys<ItemValue | Extra, ItemValue>, 'done' | 'title'>>
type _ExtraMemberRefused = Expect<Refused<Exact<ItemValue | Extra, typeof Item>>>
type Undeclared = { readonly kind: 'event'; readonly at: string }
type _UndeclaredMemberRefused = Expect<Refused<Exact<ItemValue | Undeclared, typeof Item>>>
// A required `undefined` key is a field the output does not declare.
type _RequiredUndefined = Expect<Equals<ExtraKeys<NoteValue & { readonly done: undefined }, NoteValue>, 'done'>>

describe('optional undefined keys of a union output', () => {
	test('projection drops them, so the output holds only declared fields', () => {
		const value: unknown = { kind: 'note', title: 'a', done: undefined }
		expect(project(Items, [value, { kind: 'task', done: true, title: undefined }])).toStrictEqual([{ kind: 'note', title: 'a' }, {
			kind: 'task',
			done: true,
		}])
		expect(project(Item, value)).toStrictEqual({ kind: 'note', title: 'a' })
	})
})
