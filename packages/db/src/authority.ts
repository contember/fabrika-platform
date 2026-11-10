// What a capability admits of a table's rows beyond its containment: the relations it is held through and the
// condition its action holds a row under. Every predicate a capability scopes is built through `refScope`,
// `viewScope` or `conditioned`, so neither is left out of a statement by a builder that forgot it.

import { AndNode, BinaryOperationNode, type OperationNode, OperatorNode, ParensNode, ValueNode } from 'kysely'
import { ownEntry } from './builtins'
import type { ContainerGrant, RefGrant, WithinGrant } from './capability'
import { conditionNode, subquery } from './condition-nodes'
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

/**
 * The rows of `model` a relation reaches for `principal` under `action`: `T.<node> in (select S.<node> from S where
 * S.<principal> = $me and <active>)` where `model` lies at a node of the relation's dimension, and one
 * `T.<ancestor> in (<revealed nodes>)` per reveal of `action` to an ancestor `model` lies at. Empty where neither holds.
 * A `Within`'s read (`reads`) also follows the secondary paths: the column `model` reaches the relation's dimension
 * through, and the reveals matched through one. Every other statement follows containment only.
 */
export function relationTerms(
	relations: RelationSources,
	model: TableModel,
	relation: string,
	principal: string,
	action: string,
	now: Date,
	reads: boolean,
): readonly OperationNode[] {
	const source = relationSource(relations, relation)
	const at = nodeColumnOf(model, source.dimension)
	const terms: OperationNode[] = at === undefined ? [] : [isIn(model.name, at, relationNodes(source, principal, now))]
	for (let index = 0; reads && index < model.readThrough.length; index++) {
		const path = model.readThrough[index]
		const through = path === undefined ? undefined : throughPath(model.name, path, source.dimension, relationNodes(source, principal, now))
		if (through !== undefined) terms[terms.length] = through
	}
	for (let index = 0; index < source.reveals.length; index++) {
		const reveal = source.reveals[index]
		const held = reveal !== undefined && includes(reveal.actions, action) && (reads || reveal.path === undefined)
		const placed = reveal === undefined || !held ? undefined : nodeColumnOf(model, reveal.dimension)
		if (reveal !== undefined && placed !== undefined) {
			terms[terms.length] = isIn(model.name, placed, revealedNodes(source, reveal, principal, now))
		}
	}
	return terms
}

/**
 * The rows of `model` a `Within`'s read reaches through member reveals: `revealingTerms` of its grants at revealing
 * dimensions.
 */
export function memberTerms(members: MemberReveals, model: TableModel, grant: WithinGrant, now: Date): readonly OperationNode[] {
	return revealingTerms(members, model, `the Within of ${grant.dimension}`, grant.action, grant.revealing, now)
}

/**
 * The rows of `model` that `revealing`, grants of `action` at nodes of revealing dimensions, reach through member
 * reveals: per grant, `T.<ancestor> in (select R.<ancestor> from R where R.<key> in (values) and <when>)` for each reveal
 * of `action` to an ancestor `model` lies at. A grant at a dimension that reveals no node for `action` is refused: the
 * framework passes none.
 */
export function revealingTerms(
	members: MemberReveals,
	model: TableModel,
	holder: string,
	action: string,
	revealing: readonly ContainerGrant[],
	now: Date,
): readonly OperationNode[] {
	const terms: OperationNode[] = []
	for (let index = 0; index < revealing.length; index++) {
		const grant = revealing[index]
		if (grant === undefined) continue
		const reveals = ownEntry(members, grant.dimension) ?? []
		let named = false
		for (let position = 0; position < reveals.length; position++) {
			const reveal = reveals[position]
			if (reveal === undefined || !includes(reveal.actions, action)) continue
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
 * at the node, and its action's condition. A relation or a revealing grant that does not reach `model` leaves the Ref
 * unenforceable there, never unconditioned.
 */
export function refScope(
	reach: LayerReach,
	model: TableModel,
	links: readonly Container[],
	grant: RefGrant,
	now: Date,
	row?: OperationNode,
): OperationNode {
	const linked = linksPredicate(model.name, linkValues(model.name, links, grant))
	const chain = row === undefined ? linked : allOf([row, linked])
	const gate = relationGate(reach, model, grant, now)
	return conditioned(model, grant.action, gate === undefined ? chain : allOf([chain, gate]), now)
}

/**
 * The rows of a child view whose parent row `reached` admits: `V.<column> in (select P.<key> from P where <reached>)`,
 * after `row` when it addresses one row, then the view's own condition of `action`. For `all`, every parent row, so a
 * row whose parent column names none is still read by no capability. No column of the view places a row: its
 * containment rests on the parent's foreign keys (ADR-0072).
 */
export function viewScope(
	model: TableModel,
	parent: ViewParentLink,
	action: string,
	reached: OperationNode | 'all',
	now: Date,
	row?: OperationNode,
): OperationNode {
	const member = isIn(model.name, parent.column, subquery(parent.table, parent.key, reached === 'all' ? undefined : reached))
	return conditioned(model, action, row === undefined ? member : allOf([row, member]), now)
}

/**
 * The rows a Ref held through relations or member reveals needs at `model`: a relation row at the node, or a revealing
 * row the Ref's grants reveal it through; `undefined` for a Ref an IAM grant holds.
 */
export function relationGate(reach: LayerReach, model: TableModel, grant: RefGrant, now: Date): OperationNode | undefined {
	if (grant.relations.length === 0 && grant.revealing.length === 0) {
		return undefined
	}
	const terms: OperationNode[] = []
	for (let index = 0; index < grant.relations.length; index++) {
		const relation = grant.relations[index] ?? ''
		const reached = relationTerms(reach.relations, model, relation, grant.principal, grant.action, now, false)
		if (reached.length === 0) {
			throw new CapabilityError(
				'unenforceable',
				`the Ref of ${grant.dimension} is held through ${relation}, whose dimension ${model.name} carries no column for, and which reveals none of its nodes for ${grant.action}`,
			)
		}
		for (let position = 0; position < reached.length; position++) {
			const term = reached[position]
			if (term !== undefined) terms[terms.length] = term
		}
	}
	if (grant.revealing.length > 0) {
		const revealed = revealingTerms(reach.members, model, `the Ref of ${grant.dimension}`, grant.action, grant.revealing, now)
		if (revealed.length === 0) {
			throw new CapabilityError(
				'unenforceable',
				`the Ref of ${grant.dimension} is held through member reveals, none of which reveals a node ${model.name} lies at for ${grant.action}`,
			)
		}
		for (let position = 0; position < revealed.length; position++) {
			const term = revealed[position]
			if (term !== undefined) terms[terms.length] = term
		}
	}
	return anyOf(terms)
}
