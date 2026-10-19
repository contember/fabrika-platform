// A kit application that signs and verifies tokens (`signed-tokens.test.ts`).

import { app } from './src/app-kit'
import { bookings, mail, staff } from './src/mail/endpoints'

export const contract = app.contract((c) => ({ api: c.rpc('/api', { mail, bookings, staff }), health: c.health('/healthz') }))
