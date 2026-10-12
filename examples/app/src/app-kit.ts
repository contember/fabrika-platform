// Cloudflare has no `@fabrika/db` yet, so the kit has no tables: every endpoint answers from the caller's own grants.

import { defineApp } from '@fabrika/app/contract'
import { vocabulary } from './vocabulary'

export const app = defineApp(vocabulary)
