// The generated webhook binding endpoints and a file collection's list query are described twice: as the shapes the artifact carries (`build.ts`) and
// as the zod schemas `implement` parses with (`webhook.ts`). The two must describe each other exactly.

import { describe, expect, test } from 'bun:test'
import {
	FILE_LIST_INPUT,
	FILE_LIST_OUTPUT,
	WEBHOOK_BIND_INPUT,
	WEBHOOK_BIND_OUTPUT,
	WEBHOOK_UNBIND_INPUT,
	WEBHOOK_UNBIND_OUTPUT,
} from '../contract/build'
import { Problems } from '../contract/problems'
import { describeSchema } from '../contract/schema-shape'
import { FileListInput, FileListOutput } from '../files/collections'
import { webhookBindInput, webhookBindOutput, webhookUnbindInput, webhookUnbindOutput } from '../implement/webhook'

describe('the webhook binding endpoints', () => {
	test('the zod schemas implement parses with describe the shapes the artifact carries', () => {
		const problems = new Problems()
		expect(describeSchema(webhookBindInput, 'bind input', problems)).toEqual(WEBHOOK_BIND_INPUT)
		expect(describeSchema(webhookBindOutput, 'bind output', problems)).toEqual(WEBHOOK_BIND_OUTPUT)
		expect(describeSchema(webhookUnbindInput, 'unbind input', problems)).toEqual(WEBHOOK_UNBIND_INPUT)
		expect(describeSchema(webhookUnbindOutput, 'unbind output', problems)).toEqual(WEBHOOK_UNBIND_OUTPUT)
		expect(() => problems.throwIfAny()).not.toThrow()
	})
})

describe("a file collection's list query", () => {
	test('the zod schemas the files runtime parses with describe the shapes the artifact carries', () => {
		const problems = new Problems()
		expect(describeSchema(FileListInput, 'list input', problems)).toEqual(FILE_LIST_INPUT)
		expect(describeSchema(FileListOutput, 'list output', problems)).toEqual(FILE_LIST_OUTPUT)
		expect(() => problems.throwIfAny()).not.toThrow()
	})
})
