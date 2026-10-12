// @fabrika/db/tables — the table policies of `src/db/tables.ts` as data. Browser- and Worker-safe: no Bun API and no
// driver, so `@fabrika/app/contract` and the static contract reader in `@fabrika/check` import it.

import type { ColumnPolicyArtifact, TablePolicyArtifact, TableScope } from '@fabrika/auth-core'
import { freeze, namesOf, ownEntry, ownKeys, setOwn } from './builtins'
import { modelOf, type ScopeModel, type TableModel, tableModels, type Tables } from './policy'

export { PolicyError } from './errors'
export type {
	AnyDbIndex,
	ChildRows,
	ContainedRows,
	CountOptions,
	DataKind,
	DbIndex,
	IndexedTable,
	ListOptions,
	ListPage,
	NoUnscoped,
	OrderTerm,
	OwnerRow,
	ReferenceRows,
	ReferenceTables,
	RowFor,
	RowOf,
	Saved,
	ScopeTarget,
	TableNameOf,
	TargetForm,
	TargetRow,
	Unavailable,
	UnownedTarget,
	UnscopedDeclaration,
	UnscopedInsert,
	UnscopedMode,
	UnscopedRows,
	UnscopedTables,
	VersionArguments,
	WithinRows,
	WithinTables,
} from './orm-types'
export {
	type ChildPolicy,
	type ChildScope,
	type ColumnList,
	defineTables,
	type DimensionPolicy,
	type DimensionScope,
	type InboxPolicy,
	type InboxScope,
	isTables,
	readTables,
	type ReferencePolicy,
	type ReferenceScope,
	type TableActions,
	type TableInsert,
	Tables,
	type TableUpdate,
	type VersionColumn,
	type VocabularyTables,
} from './policy'
export type {
	ColumnTypes,
	DefineVocabularyPolicies,
	NormalizedPolicies,
	TableVocabulary,
	TypedColumnList,
	VocabularyAction,
	VocabularyChildScope,
	VocabularyContainer,
	VocabularyContainerOf,
	VocabularyDimension,
	VocabularyDimensionScope,
	VocabularyPolicyMap,
	VocabularyTablePolicy,
} from './vocabulary-tables'

/** Every table's policy in the form the contract artifact carries, by table name. */
export type TablePolicies = Readonly<Record<string, TablePolicyArtifact>>

/** The artifact form of every policy `defineTables` (or `readTables`) checked. */
export function tablePolicies<DB, P>(tables: Tables<DB, P>): TablePolicies {
	const models = tableModels(tables)
	const names = ownKeys(models)
	const artifacts: Record<string, TablePolicyArtifact> = {}
	for (let index = 0; index < names.length; index++) {
		const model = modelOf(models, names[index] ?? '')
		if (model !== undefined) {
			setOwn(artifacts, model.name, artifactOf(model))
		}
	}
	return freeze(artifacts)
}

function artifactOf(model: TableModel): TablePolicyArtifact {
	const columns: Record<string, ColumnPolicyArtifact> = {}
	const declared = [...ownKeys(model.columnReads), ...ownKeys(model.columnWrites)]
	for (let index = 0; index < declared.length; index++) {
		const name = declared[index] ?? ''
		const read = ownEntry(model.columnReads, name)
		const write = ownEntry(model.columnWrites, name)
		setOwn(columns, name, { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) })
	}
	return {
		scope: scopeOf(model.scope),
		actions: {
			read: model.actions.read,
			insert: model.actions.insert ?? null,
			update: model.actions.update ?? null,
			delete: model.actions.delete ?? null,
		},
		insert: [...namesOf(model.insert)],
		update: [...namesOf(model.update)],
		version: model.version ?? null,
		createdBy: model.createdBy ?? null,
		columns,
	}
}

function scopeOf(scope: ScopeModel): TableScope {
	switch (scope.mode) {
		case 'dimension':
			return {
				mode: 'dimension',
				dimension: scope.dimension,
				key: scope.key,
				container: scope.container === undefined ? null : { dimension: scope.container.dimension, column: scope.container.column },
			}
		case 'child':
			return { mode: 'child', parent: scope.parent, key: scope.key, column: scope.column, inherit: [...scope.inherit] }
		case 'reference':
			return { mode: 'reference', reason: scope.reason }
		case 'inbox':
			return { mode: 'inbox', form: scope.form }
	}
}
