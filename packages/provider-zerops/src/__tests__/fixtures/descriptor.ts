import { createZeropsArtifactSourceDescriptor } from '../../manifest'

export const SOURCE_DESCRIPTOR = await createZeropsArtifactSourceDescriptor('# original source identity\r\nzerops: [{setup: api}]\r\n')
export const CANONICAL_DESCRIPTOR = 'zerops:\n  - setup: api\n'
