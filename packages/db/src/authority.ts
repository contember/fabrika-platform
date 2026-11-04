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
import { type Container, nodeColumnOf, type RelationSource, type TableModel } from './policy'

/** Every relation of the layer, by name, with its source table. */
export type RelationSources = Readonly<Record<string, RelationSource>>

export function relationSource(relations: RelationSources, relation: string): RelationSource {
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
 * `T.<node> in (select S.<node> from S where S.<principal> = $me and <active>)`: the rows of `model` a relation
 * reaches for `principal`; `undefined` where `model` lies at no node of the relation's dimension.
 */
export function relationTerm(
	relations: RelationSources,
	model: TableModel,
	relation: string,
	principal: string,
	now: Date,
): OperationNode | undefined {
	const source = relationSource(relations, relation)
	const at = nodeColumnOf(model, source.dimension)
	if (at === undefined) {
		return undefined
	}
	const where = allOf([equals(source.table, source.principal, principal), ...activeRow(source, now)])
	return BinaryOperationNode.create(column(model.name, at), OperatorNode.create('in'), subquery(source.table, source.node, where))
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
		const term = relationTerm(relations, model, relation, grant.principal, now)
		if (term === undefined) {
			throw new CapabilityError(
				'unenforceable',
				`the Ref of ${grant.dimension} is held through ${relation}, whose dimension ${model.name} carries no column for`,
			)
		}
		terms[terms.length] = term
	}
	return anyOf(terms)
}
