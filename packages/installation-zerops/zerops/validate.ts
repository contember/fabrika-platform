import type { Artifact } from './artifacts'
import { importSchema, zeropsYamlSchema } from './installation-schemas'

export type SchemaKind = 'import' | 'zerops-yaml'
export interface SchemaViolation {
	path: string
	message: string
}
export const parseYaml = (text: string): unknown => Bun.YAML.parse(text)
export const validateDocument = (kind: SchemaKind, document: unknown): SchemaViolation[] => {
	const result = (kind === 'import' ? importSchema : zeropsYamlSchema).safeParse(document)
	return result.success ? [] : result.error.issues.map((issue) => ({
		path: issue.path.map((part, index) => typeof part === 'number' ? `[${part}]` : `${index === 0 ? '' : '.'}${part}`).join(''),
		message: issue.message,
	}))
}
export const validateYaml = (kind: SchemaKind, text: string): SchemaViolation[] => validateDocument(kind, parseYaml(text))
export const schemaKindFor = (path: string): SchemaKind => path.endsWith('.zerops-import.yaml') ? 'import' : 'zerops-yaml'
export const assertArtifactMatchesSchema = (artifact: Artifact): void => {
	const kind = schemaKindFor(artifact.path)
	const violations = validateYaml(kind, artifact.content)
	if (violations.length > 0) {
		const detail = violations.map((violation) => `  ${violation.path === '' ? '(root)' : violation.path}: ${violation.message}`).join('\n')
		throw new Error(`${artifact.path} does not match the supported installation ${kind} schema:\n${detail}`)
	}
}
