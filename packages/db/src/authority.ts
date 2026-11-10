// What a capability admits of a table's rows beyond its containment: the relations it is held through and the
// condition its action holds a row under. Every predicate a capability scopes is built through `refScope`,
// `viewScope` or `conditioned`, so neither is left out of a statement by a builder that forgot it.

import { AndNode, BinaryOperationNode, type OperationNode, OperatorNode, ParensNode, ValueNode } from 'kysely'
import { ownEntry } from './builtins'
import type { ContainerGrant, RefGrant, WithinGrant } from './capability'
import { conditionNode, subquery } from './condition-nodes'
import type { ConditionModel } from './conditions'
import { CapabilityError } from './errors'
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
	readonly reveals: readonly RevealModel[]
	/** The actions some table's `relationWhen` narrows the relation for: it holds them only on the rows that condition admits. */
	readonly narrowed: readonly string[]
}

/** Every relation of the layer, by name, with its source table. */
export type RelationSources = Readonly<Record<string, LayerRelation>>

/** Every member reveal of the layer, by the dimension whose grants it reveals to. */
export type MemberReveals = Readonly<Record<string, readonly MemberRevealModel[]>>

/** What a capability is held through beyond its grants: the layer's relations and its member reveals. */
export interface LayerReach {
	readonly relations: RelationSources
	readonly members: MemberReveals
}

export function relationSource(relations: RelationSources, relation: string): LayerRelation {
	const source = ownEntry(relations, relation)
	if (source === undefined) {
		throw new CapabilityError('unenforceable', `the capability is held through the relation ${relation}, which no table of the layer confers`)
	}
	return source
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

function isIn(table: string, name: string, nodes: OperationNode): OperationNode {
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
 * the reveals matched through one. Where `model`'s `relationWhen` narrows the relation for `action`, each term is
 * `(<term> and (<condition>))`, so no builder of a relation's reach leaves the condition out.
 */
export function relationTerms(
	relations: RelationSources,
	model: TableModel,
	relation: string,
	principal: string,
	action: string,
	now: Date,
	paths: PathRule,
): readonly OperationNode[] {
	const source = relationSource(relations, relation)
	const at = nodeColumnOf(model, source.dimension)
	const terms: OperationNode[] = at === undefined ? [] : [isIn(model.name, at, relationNodes(source, principal, now))]
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
	const condition = relationCondition(model, relation, action)
	if (condition === undefined) {
		return terms
	}
	const narrowed: OperationNode[] = []
	for (let index = 0; index < terms.length; index++) {
		const term = terms[index]
		if (term !== undefined) narrowed[narrowed.length] = narrowedTerm(term, conditionNode(model.name, condition, now))
	}
	return narrowed
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
	const reach = branch === 'all' ? ValueNode.createImmediate(true) : branch
	const condition = actionCondition(model, action, now)
	return condition === undefined ? reach : AndNode.create(reach, ParensNode.create(condition))
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
	reached: OperationNode | 'all' | SplitReach,
	now: Date,
	row?: OperationNode,
): OperationNode {
	const membership = (where: OperationNode | undefined) => isIn(model.name, parent.column, subquery(parent.table, parent.key, where))
	let member: OperationNode
	if (reached === 'all') {
		member = membership(undefined)
	} else if ('rest' in reached) {
		const parts: OperationNode[] = reached.rest === undefined ? [] : [membership(reached.rest)]
		for (let index = 0; index < reached.relations.length; index++) {
			const part = reached.relations[index]
			if (part !== undefined) parts[parts.length] = narrowedTerm(membership(part.reached), conditionNode(model.name, part.condition, now))
		}
		member = anyOf(parts)
	} else {
		member = membership(reached)
	}
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
		add(relationTerms(reach.relations, model, grant.relations[index] ?? '', grant.principal, grant.action, now, paths))
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
