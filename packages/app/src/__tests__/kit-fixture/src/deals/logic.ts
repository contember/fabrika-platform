import type { z } from 'zod/v4'
import type { Stage } from '../schemas'

/** Only a closed deal reopens. */
export function canReopen(stage: z.output<typeof Stage>): boolean {
	return stage === 'won' || stage === 'lost'
}
