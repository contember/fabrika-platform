// @fabrika/db/tables — the table policies of `src/db/tables.ts` as data. Browser- and Worker-safe: no Bun API and no
// driver, so `@fabrika/app/contract` and the static contract reader in `@fabrika/check` import it.

import type {
	ColumnPolicyArtifact,
	ConditionArtifact,
	ConfersArtifact,
	RevealsArtifact,
	TableActionArtifact,
	TablePolicyArtifact,
	TableScope,
} from '@fabrika/auth-core'
import { type ApplicationRowsPlan, planApplicationRows } from './application-rows'
import { freeze, namesOf, ownEntry, ownKeys, setOwn } from './builtins'
import { conditionArtifact, type ConditionModel } from './conditions'
import { PolicyError } from './errors'
import { modelOf, type RelationSource, type RevealModel, type ScopeModel, type TableModel, tableModels, type Tables } from './policy'

export { applicationRowRefusalText } from './application-rows'
export type { ApplicationRowRefusal, ApplicationRowsPlan } from './application-rows'
export { PolicyError } from './errors'
export type { FileReference } from './file-references'
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
	type FilePolicies,
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
	ColumnViews,
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
	VocabularyViewPolicy,
} from './vocabulary-tables'

/**
 * The plan of seeding one row of each application table `rows` names (table → column → value), as an endpoint access
 * case seeds its `appRows`: the order, the foreign keys that link one given row to another, and every refusal.
 * `@fabrika/check` reports the refusals from source; `@fabrika/db/testing` throws the first, both in the words of
 * `applicationRowRefusalText`.
 */
export function applicationRowsPlan<DB, P>(
	tables: Tables<DB, P>,
	rows: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): ApplicationRowsPlan {
	return planApplicationRows(tableModels(tables), rows)
}

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
		...(ownKeys(model.files).length === 0 ? {} : { files: { ...model.files } }),
		...(model.view ? { view: true } : {}),
		...(model.confers.length === 0 ? {} : { confers: confersArtifact(model.confers) }),
		...(ownKeys(model.when).length === 0 ? {} : { when: whenArtifact(model.when) }),
		...(model.reveals.length === 0 ? {} : { reveals: revealsArtifact(model.reveals) }),
		...(model.readThrough.length === 0 ? {} : { readThrough: readThroughArtifact(model) }),
	}
}

function readThroughArtifact(model: TableModel): Record<string, string> {
	const artifact: Record<string, string> = {}
	for (let index = 0; index < model.readThrough.length; index++) {
		const path = model.readThrough[index]
		if (path !== undefined) setOwn(artifact, path.dimension, path.column)
	}
	return artifact
}

function revealsArtifact(reveals: readonly RevealModel[]): Record<string, RevealsArtifact> {
	const artifact: Record<string, RevealsArtifact> = {}
	for (let index = 0; index < reveals.length; index++) {
		const reveal = reveals[index]
		if (reveal === undefined) continue
		setOwn(artifact, reveal.relation, {
			to: reveal.dimension,
			actions: [...reveal.actions],
			...(reveal.when === undefined ? {} : { when: conditionArtifact(reveal.when) }),
			...(reveal.assign === undefined ? {} : { assign: { self: reveal.assign.self } }),
		})
	}
	return artifact
}

function confersArtifact(sources: readonly RelationSource[]): Record<string, ConfersArtifact> {
	const confers: Record<string, ConfersArtifact> = {}
	for (let index = 0; index < sources.length; index++) {
		const source = sources[index]
		if (source === undefined) continue
		setOwn(confers, source.relation, {
			principal: source.principal,
			node: source.node,
			expires: source.expires ?? null,
			...(source.when === undefined ? {} : { when: conditionArtifact(source.when) }),
			assign: source.assign === undefined ? null : { maxDays: source.assign.maxDays ?? null, self: source.assign.self },
		})
	}
	return confers
}

function whenArtifact(when: Readonly<Record<string, ConditionModel>>): Record<string, ConditionArtifact> {
	const artifact: Record<string, ConditionArtifact> = {}
	const actions = ownKeys(when)
	for (let index = 0; index < actions.length; index++) {
		const action = actions[index] ?? ''
		const condition = ownEntry(when, action)
		if (condition !== undefined) setOwn(artifact, action, conditionArtifact(condition))
	}
	return artifact
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
		case 'app':
			return { mode: 'app', reason: scope.reason, key: scope.key }
	}
}
