import { defineApp } from '@fabrika/provider-cloudflare'

// The application Worker is the one `defineApp` builds, and the IAM schema is the one Control writes from the approved
// contract (ADR-0050). The deployer builds the proxy Worker from `fabrika.contract.ts` (ADR-0048) and writes the
// framework variables, the object, the files bucket and the tick itself; declaring any of them is refused.
export default defineApp({ id: 'example-app' })
