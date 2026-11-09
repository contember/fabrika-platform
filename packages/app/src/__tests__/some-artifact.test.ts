// A `some` or `none` condition in the contract artifact: the compiled artifact records it as the policy states it, and
// the parser refuses a form the policy parse would never produce.

import type { TypedColumnList } from '@fabrika/db'
import { defineTables, tablePolicies } from '@fabrika/db/tables'
import { describe, expect, test } from 'bun:test'
import { compileContract, ContractError, defineContract } from '../contract'

const vocabulary = {
	app: 'some',
	dimensions: { project: {} },
	actions: { 'projects.read': 'Read projects' },
	roles: {},
} as const

interface DB {
	projects: { id: string; version: number }
	tasks: { id: string; project_id: string; open: boolean }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'version'], foreignKeys: [] },
	tasks: {
		columns: ['id', 'project_id', 'open'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		booleans: ['open'],
	},
}

const tables = tablePolicies(
	defineTables(vocabulary, columns)({
		projects: {
			scope: { dimension: 'project' },
			actions: { read: 'projects.read' },
			version: 'version',
			when: { 'projects.read': { anyOf: [{ some: { tasks: { open: { eq: true } } } }, { none: { tasks: { open: { eq: false } } } }] } },
		},
		tasks: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
	}),
)

const contract = defineContract(vocabulary, (c) => ({ health: c.health('/healthz') }))

function problems(compile: () => unknown): readonly string[] {
	try {
		compile()
	} catch (error) {
		if (error instanceof ContractError) return error.problems
		throw error
	}
	throw new Error('the contract compiled')
}

describe('some and none in the artifact', () => {
	test('the compiled artifact records them in the policy form, its operands in canonical order', () => {
		expect(compileContract(contract, tables).tables['projects']?.when).toEqual({
			'projects.read': { anyOf: [{ none: { tasks: { open: { eq: false } } } }, { some: { tasks: { open: { eq: true } } } }] },
		})
	})

	test('the parser refuses a some that names two tables', () => {
		const projects = tables['projects']
		if (projects === undefined) throw new Error('no projects policy')
		const twoTables = {
			...tables,
			projects: { ...projects, when: { 'projects.read': { some: { tasks: { open: { eq: true } }, projects: { id: { eq: 'x' } } } } } },
		}
		expect(problems(() => compileContract(contract, twoTables))).toEqual(['artifact tables.projects.when.projects.read: Invalid input'])
	})
})
