# @fabrika/cli

The single public `fabrika` executable. It parses the top-level `platform`,
`app`, and `namespace` command areas, resolves one provider, then delegates to an
installation or provider package. It contains no provider implementation.

## Provider selection

- App commands first use `--provider`, then inspect the default-exported
  provider-authored `fabrika.config.ts`.
- `authoredAppProvider()` reads the provider identity attached by that
  provider's `defineApp()`.
- Platform commands use the same resolver. Pass `--provider` when the working
  directory has no provider-authored app config.
- `cloudflare` and `zerops` are built-in installation aliases. Any other value is
  loaded as a package specifier implementing `@fabrika/installation-contract`.

## Invariants

- Keep `fabrika` as the only public operator executable.
- Do not add provider-specific public executables.
- `fabrika-cloudflare-executor` is internal to the runner container.
- Keep command routing thin. Provider behavior belongs in the provider or
  installation package.
- **How WIDE a platform command is, is the provider's answer, not this package's**
  ([ADR-0027](../../docs/decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)).
  Zerops' `platform deploy` owns a whole ordered sequence; Cloudflare's composes
  one runner/control pair and the scaffolded workflow keeps the order. `--help` on
  a platform command therefore prints the INSTALLATION's usage — that text is the
  provider's real surface, and on Zerops it is what an operator's workflow is
  generated from.
- Do not add a closed provider union to a shared contract.
