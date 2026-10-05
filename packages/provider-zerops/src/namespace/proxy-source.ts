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

export const equalProxySources = (left: ZeropsNamespaceProxySource, right: ZeropsNamespaceProxySource): boolean =>
	left.repository.owner === right.repository.owner && left.repository.name === right.repository.name
	&& left.commitSha === right.commitSha && left.descriptor.path === right.descriptor.path
	&& left.descriptor.contents === right.descriptor.contents && left.descriptor.sha256 === right.descriptor.sha256
import { z } from 'zod'
