// Output projection over unions of objects: TypeScript widens object literals of different shapes with optional
// `undefined` keys, and projection drops them with every other field the chosen branch does not declare.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { project } from '../implement/project'

const Note = z.strictObject({ kind: z.literal('note'), title: z.string() })
const Task = z.strictObject({ kind: z.literal('task'), done: z.boolean() })
const Item = z.union([Note, Task])
const Items = z.array(Item)

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
