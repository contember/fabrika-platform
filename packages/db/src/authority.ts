// What a capability admits of a table's rows beyond its containment: the relations it is held through and the
// condition its action holds a row under. Every predicate a capability scopes is built through `refScope`,
// `withinBranch` or `conditioned`, so neither is left out of a statement by a builder that forgot it.

import { AndNode, BinaryOperationNode, type OperationNode, OperatorNode, ParensNode, ValueNode } from 'kysely'
import { ownEntry } from './builtins'
import type { RefGrant } from './capability'
import { conditionNode, subquery } from './condition-nodes'
import { CapabilityError } from './errors'
import { linksPredicate, linkValues } from './links'
import { allOf, anyOf, column, equals } from './nodes'
import { type Container, includes, nodeColumnOf, type RelationSource, type RevealModel, type TableModel } from './policy'

/** A relation of the layer: its source table, and the tables whose rows it reaches reveal an ancestor node. */
export interface LayerRelation extends RelationSource {
	readonly reveals: readonly RevealModel[]
}

/** Every relation of the layer, by name, with its source table. */
export type RelationSources = Readonly<Record<string, LayerRelation>>

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

/** `select S.<node> from S where S.<principal> = $me and <active>`: the nodes a relation holds `principal` at now. */
function relationNodes(source: RelationSource, principal: string, now: Date): OperationNode {
	return subquery(source.table, source.node, allOf([equals(source.table, source.principal, principal), ...activeRow(source, now)]))
}

function isIn(table: string, name: string, nodes: OperationNode): OperationNode {
	return BinaryOperationNode.create(column(table, name), OperatorNode.create('in'), nodes)
}

/** `select R.<ancestor> from R where R.<key> in (<the relation's nodes>) and <when>`: the nodes a reveal holds `principal` at. */
export function revealedNodes(source: RelationSource, reveal: RevealModel, principal: string, now: Date): OperationNode {
	const reached = isIn(reveal.table, reveal.key, relationNodes(source, principal, now))
	const where = reveal.when === undefined ? reached : AndNode.create(reached, ParensNode.create(conditionNode(reveal.table, reveal.when, now)))
	return subquery(reveal.table, reveal.column, where)
}

/**
 * The rows of `model` a relation reaches for `principal` under `action`: `T.<node> in (select S.<node> from S where
 * S.<principal> = $me and <active>)` where `model` lies at a node of the relation's dimension, and one
 * `T.<ancestor> in (<revealed nodes>)` per reveal of `action` to an ancestor `model` lies at. Empty where neither holds.
 */
export function relationTerms(
	relations: RelationSources,
	model: TableModel,
	relation: string,
	principal: string,
	action: string,
	now: Date,
): readonly OperationNode[] {
	const source = relationSource(relations, relation)
	const at = nodeColumnOf(model, source.dimension)
	const terms: OperationNode[] = at === undefined ? [] : [isIn(model.name, at, relationNodes(source, principal, now))]
	for (let index = 0; index < source.reveals.length; index++) {
		const reveal = source.reveals[index]
		const placed = reveal === undefined || !includes(reveal.actions, action) ? undefined : nodeColumnOf(model, reveal.dimension)
		if (reveal !== undefined && placed !== undefined) {
			terms[terms.length] = isIn(model.name, placed, revealedNodes(source, reveal, principal, now))
		}
	}
	return terms
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
 * A Ref's predicate over `links` of `model`: one equality per link of its chain, then, when the Ref is held through
 * relations, a row of one of them at the node, and its action's condition. A relation that does not reach `model`
 * leaves the Ref unenforceable there, never unconditioned.
 */
export function refScope(relations: RelationSources, model: TableModel, links: readonly Container[], grant: RefGrant, now: Date): OperationNode {
	const chain = linksPredicate(model.name, linkValues(model.name, links, grant))
	const gate = relationGate(relations, model, grant, now)
	return conditioned(model, grant.action, gate === undefined ? chain : allOf([chain, gate]), now)
}

/** The relation rows a Ref held through relations needs at `model`, or `undefined` for a Ref an IAM grant holds. */
export function relationGate(relations: RelationSources, model: TableModel, grant: RefGrant, now: Date): OperationNode | undefined {
	if (grant.relations.length === 0) {
		return undefined
	}
	const terms: OperationNode[] = []
	for (let index = 0; index < grant.relations.length; index++) {
		const relation = grant.relations[index] ?? ''
		const reached = relationTerms(relations, model, relation, grant.principal, grant.action, now)
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
	return anyOf(terms)
}
