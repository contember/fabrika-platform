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
- Do not add a closed provider union to a shared contract.
