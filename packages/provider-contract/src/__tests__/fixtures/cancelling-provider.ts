import { describeControlProviderConformance } from '../../conformance'
import { memoryHarness } from './memory-provider'

describeControlProviderConformance('CancellingProvider', memoryHarness({ cancelOnLeaseLoss: true }))
