// @fabrika/db/tables — the table policies of `src/db/tables.ts` as data. Browser- and Worker-safe: no Bun API and no
// driver, so `@fabrika/app/contract` and the static contract reader in `@fabrika/check` import it.

import type { ColumnPolicyArtifact, TableActionArtifact, TablePolicyArtifact, TableScope } from '@fabrika/auth-core'
import { freeze, namesOf, ownEntry, ownKeys, setOwn } from './builtins'
import { PolicyError } from './errors'
import { modelOf, type ScopeModel, type TableModel, tableModels, type Tables } from './policy'

export { PolicyError } from './errors'
export type {
	AnyDbIndex,
	ApplicationRows,
	ApplicationTables,
	AppRecordRows,
	ChildRows,
	ClaimedRow,
	ClaimedRowHandle,
	ClaimOptions,
	ContainedRows,
	CountOptions,
	DataKind,
	DbIndex,
	FragmentTable,
	IndexedTable,
	InsertConflict,
	InsertMethod,
	ListOptions,
	ListPage,
	NoUnscoped,
	OrderTerm,
	OwnerRow,
	PublicApplicationRows,
	PublicApplicationTables,
	PublicInsertMethod,
	ReadOnlyUnscoped,
	ReferenceRows,
	ReferenceTables,
	RowFor,
	RowOf,
	Saved,
	ScopedApplicationRows,
	ScopedApplicationTables,
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
	type ApplicationPolicy,
	type ApplicationScope,
	type ChildPolicy,
	type ChildScope,
	type ColumnList,
	defineTables,
	type DimensionPolicy,
	type DimensionScope,
	type InboxPolicy,
	type InboxScope,
	isTables,
	type QueuePolicy,
	readTables,
	type RecordActions,
	type ReferencePolicy,
	type ReferenceScope,
	type TableAction,
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

/** Each form inbox's columns, by table: the only fields its form writes. The artifact carries no column list. */
export type InboxColumns = Readonly<Record<string, readonly string[]>>

/** The columns of every inbox table `defineTables` (or `readTables`) checked. */
export function inboxColumns<DB, P>(tables: Tables<DB, P>): InboxColumns {
	const models = tableModels(tables)
	const names = ownKeys(models)
	const columns: Record<string, readonly string[]> = {}
	for (let index = 0; index < names.length; index++) {
		const model = modelOf(models, names[index] ?? '')
		if (model?.scope.mode === 'inbox') {
			setOwn(columns, model.name, freeze([...namesOf(model.columns)]))
		}
	}
	return freeze(columns)
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
			read: actionArtifact(model.actions.read) ?? noReadAction(model.name),
			insert: actionArtifact(model.actions.insert),
			update: actionArtifact(model.actions.update),
			delete: actionArtifact(model.actions.delete),
			...(model.actions.appRead.length === 0 ? {} : { appRead: [...model.actions.appRead] }),
			...(model.actions.appCount.length === 0 ? {} : { appCount: [...model.actions.appCount] }),
		},
		insert: [...namesOf(model.insert)],
		update: [...namesOf(model.update)],
		version: model.version ?? null,
		createdBy: model.createdBy ?? null,
		columns,
	}
}

/** One action as its text, so a single-action policy keeps the artifact and digest it had; several as a list; none as `null`. */
function actionArtifact(actions: readonly string[]): TableActionArtifact | null {
	const [first] = actions
	if (first === undefined) {
		return null
	}
	return actions.length === 1 ? first : [...actions]
}

function noReadAction(table: string): never {
	throw new PolicyError(`${table}: the policy needs a read action`)
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
		case 'app':
			return { mode: 'app', reason: scope.reason, key: scope.key }
	}
}
