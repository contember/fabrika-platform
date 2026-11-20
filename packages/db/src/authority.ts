// What a capability admits of a table's rows beyond its containment: the relations it is held through and the
// condition its action holds a row under. Every predicate a capability scopes is built through `refScope`,
// `viewScope` or `conditioned`, so neither is left out of a statement by a builder that forgot it.

import { AndNode, BinaryOperationNode, type OperationNode, OperatorNode, ParensNode, ValueNode } from 'kysely'
import { ownEntry } from './builtins'
import type { ContainerGrant, RefGrant, RelationHold, WithinGrant } from './capability'
import { conditionNode, subquery } from './condition-nodes'
import type { ConditionModel } from './conditions'
import { CapabilityError, PolicyError } from './errors'
import type { ViewParentLink } from './guard'
import { linksPredicate, linkValues } from './links'
import { allOf, anyOf, column, equals, valueList } from './nodes'
import {
	type Container,
	includes,
	type MemberRevealModel,
	nodeColumnOf,
	type RelationSource,
	type RevealModel,
	type SecondaryPath,
	type TableModel,
} from './policy'

/** A relation of the layer: its source table, and the tables whose rows it reaches reveal an ancestor node. */
export interface LayerRelation extends RelationSource {
	readonly kind: 'source'
	readonly reveals: readonly RevealModel[]
	/** The actions some table's `relationWhen` narrows the relation for: it holds them only on the rows that condition admits. */
	readonly narrowed: readonly string[]
	/**
	 * The source's and each reveal table's column for every dimension a row of it lies at, by table: where a hold inside
	 * a node finds whether a row that holds a destination lies inside that node.
	 */
	readonly placed: Readonly<Record<string, Readonly<Record<string, string>>>>
}

/** A relation no table confers: only access views decide what it reaches, so it has no source row to check or lock. */
export interface AccessRelation {
	readonly kind: 'access'
	readonly relation: string
	readonly dimension: string
	readonly narrowed: readonly string[]
}

/** Every relation of the layer, by name, with its source table, or the mark that only access views serve it. */
export type RelationSources = Readonly<Record<string, LayerRelation | AccessRelation>>

/** Every member reveal of the layer, by the dimension whose grants it reveals to. */
export type MemberReveals = Readonly<Record<string, readonly MemberRevealModel[]>>

/** What a capability is held through beyond its grants: the layer's relations and its member reveals. */
export interface LayerReach {
	readonly relations: RelationSources
	readonly members: MemberReveals
}

export function relationSource(relations: RelationSources, relation: string): LayerRelation {
	const source = knownRelation(relations, relation)
	if (source.kind === 'access') {
		throw new CapabilityError('unenforceable', `the relation ${relation} is served by access views only: it has no source row to check or lock`)
	}
	return source
}

/** The relation by name, conferred or served by access views; one the layer does not know is unenforceable, never ignored. */
export function knownRelation(relations: RelationSources, relation: string): LayerRelation | AccessRelation {
	const known = ownEntry(relations, relation)
	if (known === undefined) {
		throw new CapabilityError('unenforceable', `the capability is held through the relation ${relation}, which no table of the layer confers`)
	}
	return known
}

/**
 * The rows of `model` the relation's access views list for the caller: `T.<key> in (select V.<row> from V where
 * V.<principal> = $me [and V.<member> in (<nodes>)])`. A hold inside a node binds `member` to the node; a view with only
 * a member binding lists nothing for a hold anywhere, and one with only a principal binding is narrowed to the node by
 * the table's own column as every relation term is. The view's SQL decides the rest; nothing of a handler is bound.
 */
function accessTerms(
	model: TableModel,
	key: string,
	hold: RelationHold,
	principal: string,
): { readonly bound: readonly OperationNode[]; readonly free: readonly OperationNode[] } {
	const bound: OperationNode[] = []
	const free: OperationNode[] = []
	for (let index = 0; index < model.access.length; index++) {
		const access = model.access[index]
		if (access === undefined || access.relation !== hold.relation) continue
		const parts: OperationNode[] = []
		if (access.member !== undefined) {
			// A node of another dimension (a grant at an ancestor) is no key the member column holds.
			if (hold.inside === null || hold.inside.dimension !== access.dimension || hold.inside.values.length === 0) continue
			parts[parts.length] = isIn(access.view, access.member, valueList(hold.inside.values))
		}
		if (access.principal !== undefined) parts[parts.length] = equals(access.view, access.principal, principal)
		const term = isIn(model.name, key, subquery(access.view, access.row, allOf(parts)))
		if (access.member === undefined) free[free.length] = term
		else bound[bound.length] = term
	}
	return { bound, free }
}

/** A source row that confers its relation now: unexpired, and admitted by the relation's own condition. */
export function activeRow(source: RelationSource, now: Date): readonly OperationNode[] {
	const terms: OperationNode[] = []
	if (source.expires !== undefined) {
		const open = BinaryOperationNode.create(column(source.table, source.expires), OperatorNode.create('is'), ValueNode.createImmediate(null))
		const ahead = BinaryOperationNode.create(column(source.table, source.expires), OperatorNode.create('>'), ValueNode.create(now))
		terms[terms.length] = anyOf([open, ahead])
	}
	if (source.when !== undefined) {
		terms[terms.length] = conditionNode(source.table, source.when, now)
	}
	return terms
}

/**
 * A source row naming `principal`: `S.<principal> = $me`, or through its path `S.<column> in (select P.<key> from P where
 * P.<column> = $me)`. Every check of a source row's principal is built here.
 */
export function namesPrincipal(source: RelationSource, principal: string): OperationNode {
	const path = source.principalPath
	if (path === undefined) {
		return equals(source.table, source.principal, principal)
	}
	return isIn(source.table, source.principal, subquery(path.table, path.key, equals(path.table, path.column, principal)))
}

/** `select S.<node> from S where <names principal> and <active>`: the nodes a relation holds `principal` at now. */
function relationNodes(source: RelationSource, principal: string, now: Date): OperationNode {
	return subquery(source.table, source.node, allOf([namesPrincipal(source, principal), ...activeRow(source, now)]))
}

export function isIn(table: string, name: string, nodes: OperationNode): OperationNode {
	return BinaryOperationNode.create(column(table, name), OperatorNode.create('in'), nodes)
}

/**
 * The rows of `table` whose `path` column names one of `nodes` of `dimension`: `T.<column> in (nodes)` at the path's own
 * dimension, `T.<column> in (select D.<key> from D where D.<link> in (nodes))` at one above it; `undefined` elsewhere. A
 * path through the nearest container reads the container's: `T.<link> in (select C.<key> from C where <C's term>)`.
 */
export function throughPath(table: string, path: SecondaryPath, dimension: string, nodes: OperationNode): OperationNode | undefined {
	const via = path.via
	const term = pathTerm(via === undefined ? table : via.table, path, dimension, nodes)
	return via === undefined || term === undefined ? term : isIn(table, via.column, subquery(via.table, via.key, term))
}

function pathTerm(table: string, path: SecondaryPath, dimension: string, nodes: OperationNode): OperationNode | undefined {
	if (path.dimension === dimension) {
		return isIn(table, path.column, nodes)
	}
	for (let index = 0; index < path.chain.length; index++) {
		const link = path.chain[index]
		if (link !== undefined && link.dimension === dimension) {
			return isIn(table, path.column, subquery(path.table, path.key, isIn(path.table, link.column, nodes)))
		}
	}
	return undefined
}

/** `select R.<ancestor> from R where R.<key> in (<the relation's nodes>) and <when>`: the nodes a reveal holds `principal` at. */
export function revealedNodes(source: RelationSource, reveal: RevealModel, principal: string, now: Date): OperationNode {
	const nodes = relationNodes(source, principal, now)
	const through = reveal.path === undefined ? undefined : throughPath(reveal.table, reveal.path, source.dimension, nodes)
	const reached = through ?? isIn(reveal.table, reveal.key, nodes)
	const where = reveal.when === undefined ? reached : AndNode.create(reached, ParensNode.create(conditionNode(reveal.table, reveal.when, now)))
	return subquery(reveal.table, reveal.column, where)
}

/** Which secondary paths a statement follows: every one for a `Within`'s read, `heldThrough` for a `Ref`, none for a move. */
export type PathRule = (path: SecondaryPath) => boolean

export const everyPath: PathRule = () => true
export const noPath: PathRule = () => false

/** The paths that hold `action` for a `Ref` (`writeThrough`). */
export function heldThrough(action: string): PathRule {
	return (path) => includes(path.writes, action)
}

/**
 * The rows of `model` a relation reaches for `principal` under `action`: `T.<node> in (select S.<node> from S where
 * S.<principal> = $me and <active>)` where `model` lies at a node of the relation's dimension, and one
 * `T.<ancestor> in (<revealed nodes>)` per reveal of `action` to an ancestor `model` lies at. Empty where neither holds.
 * It also follows the secondary paths `paths` admits: the column `model` reaches the relation's dimension through, and
 * the reveals matched through one. A hold inside a node narrows each term to the rows inside it, by `model`'s own
 * column for the hold's dimension, and reaches none where `model` has no such column. Where `model`'s `relationWhen`
 * narrows the relation for `action`, each term carries that condition too: `(<term> and (<narrowing>))`, so no builder
 * of a relation's reach leaves either out.
 */
export function relationTerms(
	relations: RelationSources,
	model: TableModel,
	hold: RelationHold,
	principal: string,
	action: string,
	now: Date,
	paths: PathRule,
): readonly OperationNode[] {
	const relation = hold.relation
	const known = knownRelation(relations, relation)
	const access = accessReach(model, hold, principal, action, now)
	if (known.kind === 'access') {
		return access
	}
	const narrowing: OperationNode[] = []
	if (hold.inside !== null) {
		const column = nodeColumnOf(model, hold.inside.dimension)
		if (column === undefined || hold.inside.values.length === 0) {
			return access
		}
		narrowing[narrowing.length] = isIn(model.name, column, valueList(hold.inside.values))
	}
	const source = known
	const rest: OperationNode[] = []
	const at = nodeColumnOf(model, source.dimension)
	if (at !== undefined) rest[rest.length] = isIn(model.name, at, relationNodes(source, principal, now))
	const others = relationTermsOf(source, model, principal, action, now, paths, rest)
	return [...access, ...narrowedTerms(model, relation, action, now, others, narrowing)]
}

/**
 * The rows of `model` its access views list for `hold`, each carrying the relation's `relationWhen` for `action`. A view
 * bound to the hold's node decides which rows lie inside it, so the table's own column does not narrow it; a view bound
 * to the principal alone is narrowed to the node by that column, and reaches nothing where `model` has none.
 */
export function accessReach(model: TableModel, hold: RelationHold, principal: string, action: string, now: Date): readonly OperationNode[] {
	const { bound, free } = accessTerms(model, keyColumnOf(model), hold, principal)
	const terms = narrowedByRelation(model, hold.relation, action, now, bound)
	if (free.length === 0) {
		return terms
	}
	if (hold.inside === null) {
		return [...terms, ...narrowedByRelation(model, hold.relation, action, now, free)]
	}
	const column = nodeColumnOf(model, hold.inside.dimension)
	if (column === undefined || hold.inside.values.length === 0) {
		return terms
	}
	return [...terms, ...narrowedTerms(model, hold.relation, action, now, free, [isIn(model.name, column, valueList(hold.inside.values))])]
}

/** The key column a row of `model` is named by: a child's `key`, a dimension table's own key. */
function keyColumnOf(model: TableModel): string {
	if (model.scope.mode === 'child' || model.scope.mode === 'dimension') return model.scope.key
	throw new PolicyError(`${model.name}: an access view names a row of a dimension or child table only`)
}

/** `terms` with the relation's `relationWhen` for `action`, when the table declares one. */
function narrowedByRelation(
	model: TableModel,
	relation: string,
	action: string,
	now: Date,
	terms: readonly OperationNode[],
): readonly OperationNode[] {
	return narrowedTerms(model, relation, action, now, terms, [])
}

function narrowedTerms(
	model: TableModel,
	relation: string,
	action: string,
	now: Date,
	terms: readonly OperationNode[],
	inside: readonly OperationNode[],
): readonly OperationNode[] {
	const narrowing: OperationNode[] = [...inside]
	const condition = relationCondition(model, relation, action)
	if (condition !== undefined) {
		narrowing[narrowing.length] = narrowing.length === 0
			? conditionNode(model.name, condition, now)
			: ParensNode.create(conditionNode(model.name, condition, now))
	}
	if (narrowing.length === 0) {
		return terms
	}
	const narrowed: OperationNode[] = []
	for (let index = 0; index < terms.length; index++) {
		const term = terms[index]
		if (term !== undefined) narrowed[narrowed.length] = narrowedTerm(term, allOf(narrowing))
	}
	return narrowed
}

/** The secondary-path and reveal terms of a conferred relation, appended to `terms`. */
function relationTermsOf(
	source: LayerRelation,
	model: TableModel,
	principal: string,
	action: string,
	now: Date,
	paths: PathRule,
	terms: OperationNode[],
): readonly OperationNode[] {
	for (let index = 0; index < model.readThrough.length; index++) {
		const path = model.readThrough[index]
		const through = path === undefined || !paths(path)
			? undefined
			: throughPath(model.name, path, source.dimension, relationNodes(source, principal, now))
		if (through !== undefined) terms[terms.length] = through
	}
	for (let index = 0; index < source.reveals.length; index++) {
		const reveal = source.reveals[index]
		const held = reveal !== undefined && includes(reveal.actions, action) && (reveal.path === undefined || paths(reveal.path))
		const placed = reveal === undefined || !held ? undefined : nodeColumnOf(model, reveal.dimension)
		if (reveal !== undefined && placed !== undefined) {
			terms[terms.length] = isIn(model.name, placed, revealedNodes(source, reveal, principal, now))
		}
	}
	return terms
}

/** `holds` without those of a relation `narrowed` names: the holds no `relationWhen` narrows. */
export function holdsBesides(holds: readonly RelationHold[], narrowed: readonly string[]): readonly RelationHold[] {
	const kept: RelationHold[] = []
	for (let index = 0; index < holds.length; index++) {
		const hold = holds[index]
		if (hold !== undefined && !includes(narrowed, hold.relation)) kept[kept.length] = hold
	}
	return kept
}

/** The condition `model`'s `relationWhen` puts on the rows `relation` reaches for `action`, if any. */
export function relationCondition(model: TableModel, relation: string, action: string): ConditionModel | undefined {
	const conditions = ownEntry(model.relationWhen, relation)
	return conditions === undefined ? undefined : ownEntry(conditions, action)
}

/** `(<term> and (<narrowing>))`: one branch of a reach, narrowed; the one shape the guard admits a branch's condition in. */
export function narrowedTerm(term: OperationNode, narrowing: OperationNode): OperationNode {
	return ParensNode.create(AndNode.create(term, ParensNode.create(narrowing)))
}

/**
 * The rows of `model` a `Within`'s read reaches through member reveals: `revealingTerms` of its grants at revealing
 * dimensions.
 */
export function memberTerms(members: MemberReveals, model: TableModel, grant: WithinGrant, now: Date): readonly OperationNode[] {
	return revealingTerms(members, model, `the Within of ${grant.dimension}`, grant.action, grant.revealing, now, everyPath)
}

/**
 * The rows of `model` that `revealing`, grants of `action` at nodes of revealing dimensions, reach through member
 * reveals: per grant, `T.<ancestor> in (select R.<ancestor> from R where R.<key> in (values) and <when>)` for each reveal
 * of `action` to an ancestor `model` lies at, `R.<key>` the row's key or its path's column. A reveal through a path
 * counts where `paths` admits it. A grant at a dimension that reveals no node for `action` is refused: the framework
 * passes none.
 */
export function revealingTerms(
	members: MemberReveals,
	model: TableModel,
	holder: string,
	action: string,
	revealing: readonly ContainerGrant[],
	now: Date,
	paths: PathRule,
): readonly OperationNode[] {
	const terms: OperationNode[] = []
	for (let index = 0; index < revealing.length; index++) {
		const grant = revealing[index]
		if (grant === undefined) continue
		const reveals = ownEntry(members, grant.dimension) ?? []
		let named = false
		for (let position = 0; position < reveals.length; position++) {
			const reveal = reveals[position]
			if (reveal === undefined || !includes(reveal.actions, action) || (reveal.path !== undefined && !paths(reveal.path))) continue
			named = true
			const placed = nodeColumnOf(model, reveal.dimension)
			if (placed === undefined || grant.values.length === 0) continue
			terms[terms.length] = isIn(model.name, placed, memberRevealed(reveal, grant.values, now))
		}
		if (!named) {
			throw new CapabilityError(
				'unenforceable',
				`${holder} carries a grant on ${grant.dimension}, whose rows reveal no node for ${action}`,
			)
		}
	}
	return terms
}

/** `select R.<ancestor> from R where R.<key> in (values) and <when>`: the nodes a member reveal holds at for `values`. */
export function memberRevealed(reveal: MemberRevealModel, values: readonly string[], now: Date): OperationNode {
	const reached = isIn(reveal.table, reveal.key, valueList(values))
	const where = reveal.when === undefined ? reached : AndNode.create(reached, ParensNode.create(conditionNode(reveal.table, reveal.when, now)))
	return subquery(reveal.table, reveal.column, where)
}

/** The condition `action` holds a row of `model` under, or `undefined` when the action is not narrowed there. */
export function actionCondition(model: TableModel, action: string, now: Date): OperationNode | undefined {
	const condition = ownEntry(model.when, action)
	return condition === undefined ? undefined : conditionNode(model.name, condition, now)
}

/**
 * `branch`, narrowed by the condition of `action`: `<reach> and (<when>)`, for a global grant `true and (<when>)`, the
 * one shape the guard admits a condition in, so a condition never stands in for the reach.
 */
export function conditioned(model: TableModel, action: string, branch: OperationNode | 'all', now: Date): OperationNode {
	return conditionedAny(model, [action], branch, now)
}

/**
 * `branch`, narrowed as one role holding `actions` is: `<reach> and ((<when a>) or (<when b>))`, a row passing where any
 * action's condition admits it, and unnarrowed when one of them has none. `actions` are those that allow the operation,
 * at least one; for one action this is `conditioned`.
 */
export function conditionedAny(model: TableModel, actions: readonly string[], branch: OperationNode | 'all', now: Date): OperationNode {
	const reach = branch === 'all' ? ValueNode.createImmediate(true) : branch
	if (actions.length === 0) {
		throw new CapabilityError('unenforceable', `no action allows this operation on ${model.name}`)
	}
	const conditions: OperationNode[] = []
	for (let index = 0; index < actions.length; index++) {
		const action = actions[index]
		if (action === undefined) continue
		const condition = actionCondition(model, action, now)
		if (condition === undefined) {
			return reach
		}
		conditions[conditions.length] = ParensNode.create(condition)
	}
	return AndNode.create(reach, anyOf(conditions))
}

/**
 * A Ref's predicate over `links` of `model`: one equality per link of its chain (after `row`, the equality that
 * addresses one row by its key), then, when the Ref is held through relations or member reveals, a row of one of them
 * at the node, and its action's condition. A Ref whose relations, revealing grants and paths together reach no row of
 * `model` is unenforceable there, never unconditioned.
 */
export function refScope(
	reach: LayerReach,
	model: TableModel,
	links: readonly Container[],
	grant: RefGrant,
	now: Date,
	row?: OperationNode,
	paths: PathRule = heldThrough(grant.action),
): OperationNode {
	const linked = linksPredicate(model.name, linkValues(model.name, links, grant))
	const chain = row === undefined ? linked : allOf([row, linked])
	const gate = relationGate(reach, model, grant, now, paths)
	return conditioned(model, grant.action, gate === undefined ? chain : allOf([chain, gate]), now)
}

/** A child view's parent reach, split by the relations the view narrows: the rest's reach, and each such relation's own. */
export interface SplitReach {
	readonly rest: OperationNode | undefined
	readonly relations: readonly { readonly reached: OperationNode; readonly condition: ConditionModel }[]
}

/**
 * The rows of a child view whose parent row `reached` admits: `V.<column> in (select P.<key> from P where <reached>)`,
 * after `row` when it addresses one row, then the view's own condition of `action`. For `all`, every parent row, so a
 * row whose parent column names none is still read by no capability. Split by the relations the view narrows
 * (`relationWhen`), one such membership per part, each narrowed relation's ANDed with the view's condition for it. No
 * column of the view places a row: its containment rests on the parent's foreign keys (ADR-0072).
 */
export function viewScope(
	model: TableModel,
	parent: ViewParentLink,
	action: string,
	reached: OperationNode | 'all' | SplitReach | undefined,
	now: Date,
	row?: OperationNode,
	access: readonly OperationNode[] = [],
): OperationNode {
	const membership = (where: OperationNode | undefined) => isIn(model.name, parent.column, subquery(parent.table, parent.key, where))
	const parts: OperationNode[] = []
	if (reached === 'all') {
		parts[parts.length] = membership(undefined)
	} else if (reached !== undefined && 'rest' in reached) {
		if (reached.rest !== undefined) parts[parts.length] = membership(reached.rest)
		for (let index = 0; index < reached.relations.length; index++) {
			const part = reached.relations[index]
			if (part !== undefined) parts[parts.length] = narrowedTerm(membership(part.reached), conditionNode(model.name, part.condition, now))
		}
	} else if (reached !== undefined) {
		parts[parts.length] = membership(reached)
	}
	for (let index = 0; index < access.length; index++) {
		const term = access[index]
		if (term !== undefined) parts[parts.length] = term
	}
	const member = anyOf(parts)
	return conditioned(model, action, row === undefined ? member : allOf([row, member]), now)
}

/**
 * The rows a Ref held through relations, member reveals or secondary paths needs at `model`: a relation row at the node,
 * a revealing row the Ref's grants reveal it through, or a path `paths` admits naming a node its grants hold;
 * `undefined` for a Ref an IAM grant holds on its chain. A part that reaches no row of `model` adds nothing; when none
 * does, the Ref is unenforceable there, never unconditioned.
 */
export function relationGate(
	reach: LayerReach,
	model: TableModel,
	grant: RefGrant,
	now: Date,
	paths: PathRule = heldThrough(grant.action),
): OperationNode | undefined {
	if (grant.relations.length === 0 && grant.revealing.length === 0 && grant.paths.length === 0) {
		return undefined
	}
	const terms = gateTerms(reach, model, grant, now, paths)
	if (terms.length === 0) {
		throw new CapabilityError(
			'unenforceable',
			`the Ref of ${grant.dimension} is held through relations, member reveals or secondary paths, none of which reaches a row of ${model.name} for ${grant.action}`,
		)
	}
	return anyOf(terms)
}

/** Every term of `grant`'s relations, member reveals and paths at `model`; empty where none reaches it. */
export function gateTerms(reach: LayerReach, model: TableModel, grant: RefGrant, now: Date, paths: PathRule): readonly OperationNode[] {
	const terms: OperationNode[] = []
	const add = (more: readonly OperationNode[]): void => {
		for (let index = 0; index < more.length; index++) {
			const term = more[index]
			if (term !== undefined) terms[terms.length] = term
		}
	}
	for (let index = 0; index < grant.relations.length; index++) {
		const hold = grant.relations[index]
		if (hold !== undefined) add(relationTerms(reach.relations, model, hold, grant.principal, grant.action, now, paths))
	}
	if (grant.revealing.length > 0) {
		add(revealingTerms(reach.members, model, `the Ref of ${grant.dimension}`, grant.action, grant.revealing, now, paths))
	}
	if (grant.paths.length > 0) {
		add(pathTerms(model, grant.paths, paths))
	}
	return terms
}

/**
 * The rows of `model` whose path `paths` admits names a node `grants` hold: `T.<column> in (values)` at the path's own
 * dimension, `T.<column> in (select D.<key> from D where D.<link> in (values))` above it, through the container's column
 * for a path through the container.
 */
export function pathTerms(model: TableModel, grants: readonly ContainerGrant[], paths: PathRule): readonly OperationNode[] {
	const terms: OperationNode[] = []
	for (let index = 0; index < model.readThrough.length; index++) {
		const path = model.readThrough[index]
		if (path === undefined || !paths(path)) continue
		for (let position = 0; position < grants.length; position++) {
			const grant = grants[position]
			const term = grant === undefined || grant.values.length === 0 ? undefined : throughPath(model.name, path, grant.dimension, valueList(grant.values))
			if (term !== undefined) terms[terms.length] = term
		}
	}
	return terms
}
