// @fabrika/app/testing/preload — what `fabrika db test-isolation` passes to `bun test --preload`: it captures Bun's
// test functions before any application module loads.

import { installTestRunner } from './runner'

installTestRunner()
