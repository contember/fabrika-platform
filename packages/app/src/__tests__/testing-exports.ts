// The types `testKit`'s options take, pinned to `@fabrika/app/testing`: a test names each one from the module it
// imports the kit from, never through `Parameters<typeof testKit>`. Part of the package typecheck.

import type { ChallengeFetch as ImplementChallengeFetch, FileScanner as ImplementFileScanner } from '@fabrika/app/implement'
import type { ChallengeFetch, FileScanner, IamMembershipRpc, TestKitOptions } from '@fabrika/app/testing'
import type { IamMembershipRpc as AuthCoreMembershipRpc } from '@fabrika/auth-core'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

export type TestingExports = [
	Expect<Equal<IamMembershipRpc, AuthCoreMembershipRpc>>,
	Expect<Equal<ChallengeFetch, ImplementChallengeFetch>>,
	Expect<Equal<FileScanner, ImplementFileScanner>>,
	Expect<Equal<TestKitOptions['membership'], IamMembershipRpc | undefined>>,
	Expect<Equal<TestKitOptions['challengeFetch'], ChallengeFetch | undefined>>,
	Expect<Equal<TestKitOptions['scanner'], FileScanner | undefined>>,
]
