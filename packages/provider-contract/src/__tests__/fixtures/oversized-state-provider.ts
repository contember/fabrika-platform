import { describeControlProviderConformance } from '../../conformance'
import { memoryHarness } from './memory-provider'

describeControlProviderConformance('OversizedStateProvider', memoryHarness({ oversizedState: true }))
