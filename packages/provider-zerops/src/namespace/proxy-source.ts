import { z } from 'zod'
import { prepareZeropsDescriptor } from '../descriptor'
import { verifyZeropsArtifactSourceDescriptor, zeropsArtifactSourceDescriptorSchema } from '../manifest'
import { commitShaSchema, parseSourceWire, repositorySchema } from '../source/validation'
import type { ZeropsNamespaceProxySource } from './types'

export const namespaceProxySourceSchema = z.object({
	repository: repositorySchema,
	commitSha: commitShaSchema,
	descriptor: zeropsArtifactSourceDescriptorSchema,
}).strict().transform((source) => {
	prepareZeropsDescriptor(source.descriptor.contents, 'proxy')
	return source
})

export const decodeZeropsNamespaceProxySource = (value: unknown): ZeropsNamespaceProxySource =>
	parseSourceWire(namespaceProxySourceSchema, value, 'Zerops namespace proxy source')

export const verifyZeropsNamespaceProxySource = async (source: ZeropsNamespaceProxySource): Promise<void> => {
	const parsed = decodeZeropsNamespaceProxySource(source)
	await verifyZeropsArtifactSourceDescriptor(parsed.descriptor)
}
