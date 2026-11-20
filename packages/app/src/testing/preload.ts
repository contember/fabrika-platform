// @fabrika/app/testing/preload — what a test run passes to `bun test --preload`: it captures Bun's test functions
// before any application module loads.

import { installTestRunner } from './runner'

installTestRunner()
