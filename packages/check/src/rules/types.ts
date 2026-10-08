import { type AstNode, child, children, type Comment, identifierName } from '../ast'
import type { Report } from '../finding'

/** `as const` and `<const>x` fix a literal's type; they assert nothing. */
export const isConstAssertion = (node: AstNode): boolean => {
	const type = child(node, 'typeAnnotation')
	return type?.type === 'TSTypeReference' && identifierName(child(type, 'typeName')) === 'const'
}

const CAPABILITIES = new Set(['Ref', 'Within'])

const referencedName = (typeName: AstNode | undefined): string | undefined =>
	typeName?.type === 'TSQualifiedName' ? identifierName(child(typeName, 'right')) : identifierName(typeName)

export const checkTypeNode = (node: AstNode, report: Report): void => {
	switch (node.type) {
		case 'TSAsExpression':
		case 'TSTypeAssertion':
			if (!isConstAssertion(node)) {
				report(node, 'type-assertion', 'a type assertion tells the compiler to stop checking', 'a value of the right type, `satisfies T`, or `as const`')
			}
			return
		case 'TSAnyKeyword':
			report(node, 'any-type', '`any` switches type checking off', 'the concrete type, or `unknown` narrowed by a check')
			return
		case 'TSTypeReference': {
			const name = referencedName(child(node, 'typeName'))
			if (name === undefined || !CAPABILITIES.has(name)) return
			const typeArguments = child(node, 'typeArguments')
			const parameters = typeArguments === undefined ? [] : children(typeArguments, 'params')
			if (parameters.some((parameter) => parameter?.type === 'TSStringKeyword')) {
				report(
					node,
					'capability-widening',
					`${name}<string, …> widens a capability to any dimension or action`,
					`${name}<'<dimension>', '<action>'> with literal names`,
				)
			}
			return
		}
	}
}

const SUPPRESSIONS = /@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore|eslint-disable|oxlint-disable/

export const checkComments = (comments: readonly Comment[], report: Report): void => {
	for (const comment of comments) {
		const found = SUPPRESSIONS.exec(comment.text)
		if (found === null) continue
		report(
			comment.position,
			'suppression-comment',
			`'${found[0]}' suppresses a check, and this checker recognises no suppression either`,
			'code that passes the check',
		)
	}
}
