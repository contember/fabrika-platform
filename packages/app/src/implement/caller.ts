// The caller's row (`ctx.caller`), read once per request before the handler, in the invocation's transaction: no row,
// or a row a refusal of the declaration meets, is a 403 and the handler never runs.

import type { DataHandles } from '@fabrika/db/framework'
import { type CallerDeclaration, callerRefusal } from '../contract/caller'
import { ForbiddenError } from '../errors'
import { ServerFault } from './faults'
import type { Principal } from './principal'

/**
 * The person's row of the declared table. Only a person (`user`) has one: any other principal gets `null`, which the
 * group's caller kinds already promise the handler.
 */
export async function resolveCaller(
	declaration: CallerDeclaration,
	handles: Pick<DataHandles, 'rowsNaming'>,
	principal: Principal,
): Promise<Readonly<Record<string, unknown>> | null> {
	if (principal.kind !== 'user') {
		return null
	}
	const rows = await handles.rowsNaming(declaration.table, declaration.principal, principal.id)
	if (rows.length > 1) {
		throw new ServerFault(
			'caller_ambiguous',
			`${declaration.table} holds more than one row whose ${declaration.principal} is the caller's principal id`,
		)
	}
	const row = rows[0]
	if (row === undefined) {
		throw new ForbiddenError(declaration.missing)
	}
	for (const rule of declaration.refuse ?? []) {
		if (!Object.hasOwn(row, rule.column)) {
			throw new ServerFault(
				'caller_column',
				`caller.refuse names ${rule.column}, which a ${declaration.table} row read with its read action does not hold`,
			)
		}
	}
	const refused = callerRefusal(declaration, row)
	if (refused !== null) {
		throw new ForbiddenError(refused)
	}
	return Object.freeze({ ...row })
}
