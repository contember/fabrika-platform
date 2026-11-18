// Validation by the approved shapes: an endpoint validates with the application's own schema (its messages and
// defaults), once that schema's shape is the one the approved contract holds for the endpoint. Boot checks only the
// contract's digest, so each endpoint's schemas are read and compared the first time it uses them.

import {
	canonicalJson,
	canonicalShape,
	type EndpointRow,
	isAttachmentShape,
	isFileShape,
	isRedirectShape,
	type SchemaShape,
} from '@fabrika/auth-core'
import type { Schema } from '../contract/define'
import { Problems } from '../contract/problems'
import { describeSchema } from '../contract/schema-shape'
import { ServerFault } from './faults'

type Slot = 'input' | 'output'

const approved = new WeakMap<EndpointRow, Map<Slot, Schema>>()

/** `schema`, the endpoint's input, once its shape is the row's. */
export function approvedInput(row: EndpointRow, schema: Schema): Schema {
	return approvedIn(row, 'input', row.input, schema)
}

/**
 * `schema`, the endpoint's JSON output, once its shape is the row's. A redirect's target, an attachment's rows and a
 * file stand in the row in a form of their own, so their schemas are not compared.
 */
export function approvedOutput(row: EndpointRow, schema: Schema): Schema {
	const output = row.output
	if (output === null || isRedirectShape(output) || isAttachmentShape(output) || isFileShape(output)) {
		return schema
	}
	return approvedIn(row, 'output', output, schema)
}

function approvedIn(row: EndpointRow, slot: Slot, expected: SchemaShape | null, schema: Schema): Schema {
	const checked = approved.get(row)
	if (checked?.get(slot) === schema) {
		return schema
	}
	if (expected === null || !hasShape(schema, expected, `'${row.id}' ${slot}`)) {
		throw new ServerFault('schema_unapproved', `'${row.id}': the ${slot} schema the application evaluated is not the one its approved contract holds`)
	}
	approved.set(row, (checked ?? new Map<Slot, Schema>()).set(slot, schema))
	return schema
}

/** Whether `schema` reads to the canonical shape `expected`; a schema outside the subset never does. */
export function hasShape(schema: Schema, expected: SchemaShape, where: string): boolean {
	const problems = new Problems()
	const actual = describeSchema(schema, where, problems)
	return actual !== null && problems.isEmpty() && canonicalJson(canonicalShape(actual)) === canonicalJson(canonicalShape(expected))
}
