# Rotating keys: the proxy secret, IAM's signing keys, the vault key

The operator's procedure for the three installation credentials that no `fabrika` command rotates. The others are in
[Revoking and rotating](security-guarantees.md#revoking-and-rotating). Each step names the command, the setting or the
file it changes.

Every procedure handles key material in files, never on a command line, in a scratch directory only you can read:

```bash
umask 077 && cd "$(mktemp -d)"
```

Delete that directory when the procedure is done; keep the old value only where the procedure says.

## The proxy secret of an application environment

`FABRIKA_PROXY_SECRET` proves to an application that a request came from its proxy (ADR-0022 rule 5). Control
generates one per application environment the first time it needs it, seals it in the vault under
`platform:proxy-secret:<app>@<env>`, and records only the vault ref in `app_env_proxy_secrets`
([`proxy-secret.ts`](../../packages/control/src/proxy-secret.ts)). A deploy writes it to both sides:

- **Zerops:** the namespace's `proxy` service holds it as `FABRIKA_PROXY_SECRET_<32 hex>` (`proxySecretVariable`), the
  application's service as `FABRIKA_PROXY_SECRET`, both sensitive.
- **Cloudflare:** the application Worker holds it as the Worker secret `FABRIKA_PROXY_SECRET` and forwards it to its
  Durable Object. An application on a framework release before 0.9 has none and nothing to rotate.

There is no rotation verb. Rotating means making Control forget the secret, so the next deploy generates a new one and
writes it to both sides.

1. **Read the vault ref** of the environment from Control's database:

   ```sql
   SELECT value_ref FROM app_env_proxy_secrets WHERE app_id = '<app>' AND env = '<env>';
   ```

   It answers `vault:<id>`. On Zerops, run it with `psql` against Control's database (see
   [Reaching Control's database on Zerops](#reaching-controls-database-on-zerops)). On Cloudflare:
   `npx wrangler d1 execute prod-fabrika-control --remote --command "<the statement>"` (an installation created before
   the `fabrika` names, whose GitHub Environment has no `FABRIKA_CLOUDFLARE_NAMES`, uses `prod-vozka`).

2. **Note the commit the environment runs:** `fabrika control runs list --app=<app> --env=<env> --limit=5` lists its
   runs; take the commit of the newest `succeeded` one. Deploying that commit changes nothing but the secret.

3. **Delete the record and the vault row**, in this order, with the same tool as step 1:

   ```sql
   DELETE FROM app_env_proxy_secrets WHERE app_id = '<app>' AND env = '<env>';
   DELETE FROM vault WHERE id = '<id from step 1>';
   ```

   A failure between the two leaves an unreferenced vault row, which harms nothing; delete it when you can.

4. **Deploy the environment at once:** `fabrika control deploy --app=<app> --env=<env> --ref=<commit from step 2>`, or
   **Deploy** on the environment in the console. A protected environment takes the console: a manual deploy there
   needs a person. Follow it with `fabrika control runs get --run=<id>` until it is `succeeded`.

   - **On Zerops** the deploy first republishes the namespace proxy with the new secret, then builds the application
     with it. Between the two the application refuses every proxied request, for as long as its build and activation
     take. Any republish of the namespace after step 3 (another member's deploy, a domain change,
     `namespaces reconcile`) also hands the proxy the new secret, which is why the deploy follows step 3 at once.
   - **On Cloudflare** the Worker and its object get the new secret in one deploy.
   - If the deploy fails, the application keeps refusing proxied requests (Zerops) until a deploy of it succeeds. Fix
     the cause and deploy again; the new secret is already recorded and is reused.

5. **Check:** the environment answers through its domain, and `SELECT value_ref …` from step 1 names a new `vault:` id.

A `dev` environment's sandboxes each hold their own proxy secret (`dev_sandboxes.proxy_secret_ref`); a sandbox that is
removed and created again gets a new one.

## IAM's signing keys

`FABRIKA_IAM_SIGNING_KEYS` is a JSON array of ES256 private JWKs. IAM signs with the first and publishes every key at
`<IAM origin>/.well-known/jwks.json` ([`signing.ts`](../../packages/iam/src/signing.ts)). Every verifier (the proxies,
Control, Operations, the applications) caches that set for up to 600 s and refetches it at most every 30 s when it meets
an unknown key id ([`verifier.ts`](../../packages/jwks/src/verifier.ts)). What IAM signs with the key:

| What                                 | Lifetime | When its key is gone                                                                |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------- |
| Access tokens, OAuth resource tokens | 300 s    | Refused until it expires                                                            |
| The OIDC sign-in flight cookie       | 600 s    | A sign-in started before the key went fails and is started again                    |
| The known-device cookie              | 90 days  | The browser's next password sign-in is throttled by the shared buckets, not its own |

Sessions and API keys are not signed with it and survive every step below.

Where the value lives:

- **Zerops:** the sensitive variable `FABRIKA_IAM_SIGNING_KEYS` of the `iam` service. The only readable copy is the
  secrets file `platform install` wrote (`--secrets-file`); `platform deploy` and `upgrade` never write the variable.
- **Cloudflare:** the secret `FABRIKA_IAM_SIGNING_KEYS` of the sidecar repository's GitHub Environment (named after the
  account), which the `platform` workflow pushes to IAM's Worker on every run. The readable copy is the installer env
  file `$XDG_CONFIG_HOME/fabrika/cloudflare/<account>/.env` (`~/.config/…` without `XDG_CONFIG_HOME`), which a re-run
  of `platform init` reuses, so it must follow every change.

### Planned rotation

1. **Write the current value** to `current.json`. Zerops:
   `( set -a && . <secrets file> && set +a && printf '%s' "$FABRIKA_IAM_SIGNING_KEYS" ) > current.json`. Cloudflare: the
   same with the installer env file in place of the secrets file.

2. **Generate the new key** from a checkout of the installation's release (the tag in the sidecar's `fabrika.ref`)
   after `bun install`, and build the three values the rotation goes through:

   ```bash
   ( cd <checkout>/packages/installation-init && bun -e "import { generateSigningKeys } from './src/secrets'; process.stdout.write(generateSigningKeys())" ) > new.json
   jq -c '. + input' current.json new.json > publish.json   # the old key signs, the new one is published
   jq -c '[.[1], .[0]]' publish.json > promote.json          # the new key signs, the old one still verifies
   jq -c '[.[0]]' promote.json > retire.json                 # the new key alone
   ```

   `current.json` holds one key unless an earlier rotation was left unfinished; retire that one first.

3. **Publish:** set `FABRIKA_IAM_SIGNING_KEYS` to `publish.json` and restart IAM ([Setting the value](#setting-the-value)).
   Check: `curl -s <IAM origin>/.well-known/jwks.json | jq -r '.keys[].kid'` lists the old key id first, then the new one
   (`jq -r '.[].kid' publish.json`).

4. **Wait 600 s**, so every verifier's cached set holds the new key before anything is signed with it.

5. **Promote:** set the variable to `promote.json` and restart IAM. Check: the JWKS lists the new key id first.

6. **Wait 600 s**, the longest an access token or a flight cookie signed with the old key stays valid. A known-device
   cookie signed with it (90 days) stops counting at step 7, and its browser is throttled by the shared buckets until
   its next password sign-in.

7. **Retire:** set the variable to `retire.json` and restart IAM. Check: the JWKS lists the new key id alone. Delete
   the scratch directory.

### A leaked key

Skip the waits: set the variable to `retire.json` (the new key alone) and restart IAM.
A verifier that has not refetched yet keeps trusting the leaked key for up to 600 s, and a token minted before the
switch (at most 300 s old) is refused, once its verifier has refetched, until it expires.

### Setting the value

- **Zerops:** `zops env set --sensitive` refuses to update an existing sensitive variable
  ([zerops-platform.md](zerops-platform.md)), so delete it and create it again, then restart:

  ```bash
  zops env unset FABRIKA_IAM_SIGNING_KEYS iam
  zops env set FABRIKA_IAM_SIGNING_KEYS - iam --sensitive --restart < publish.json
  ```

  Or edit the secret variable of `iam` in the Zerops GUI and restart the service. IAM refuses to start without a key,
  so a restart between the two commands leaves sign-in down until the second one runs.
- **Cloudflare:** write the GitHub Environment secret and run the platform workflow, which deploys IAM, Operations and
  Control at the pinned release:

  ```bash
  gh secret set FABRIKA_IAM_SIGNING_KEYS --env <account> --repo <owner>/<sidecar repository> < publish.json
  gh workflow run platform.yml --repo <owner>/<sidecar repository>
  ```

  Wait for the run to succeed (`gh run list --workflow=platform.yml --repo …`) before the check.

After each change, replace the readable copy too: in the Zerops secrets file or the Cloudflare env file, replace the
`FABRIKA_IAM_SIGNING_KEYS='…'` line with `FABRIKA_IAM_SIGNING_KEYS='<the value just set>'`, so a procedure resumed later,
or a re-run of `platform init`, starts from what IAM holds.

## The vault key (KEK)

`FABRIKA_CONTROL_VAULT_KEY` wraps the data key of every vault row: application secrets on Cloudflare and in `dev`
environments, proxy secrets, workload, membership, connector, token and ops keys, and the GitHub App credentials
([`vault.ts`](../../packages/control/src/vault.ts)). Only Control holds it. The rotation re-wraps each row's data key
under the new key; no secret value is decrypted to anything but memory, and none changes.

The script is `bun run --cwd packages/control rotate-vault-key`
([`rotate-vault-key.ts`](../../packages/control/src/bun/rotate-vault-key.ts)). It reads three environment variables:
`FABRIKA_CONTROL_DATABASE_URL`, `FABRIKA_CONTROL_VAULT_KEY` (the key Control runs with) and
`FABRIKA_CONTROL_VAULT_KEY_NEW`. It opens every row with both keys, re-wraps every row the current key opens in ONE
transaction, opens every row again, and exits 0 only when every row opens with the new key and none with the current
one. `--check` only counts and writes nothing. It prints counts and row ids, never a key or a value.

It runs on a Zerops installation, whose Control database is Postgres. **On Cloudflare no command rotates the vault key**:
Control's database is D1, which the script cannot reach, and Control's Worker cannot be stopped.

### Rotation on Zerops

Control is stopped for the whole procedure. Applications, IAM and the proxies keep serving; the console, deploys, the
GitHub push webhooks (a push during the window is not deployed: redeliver it from the GitHub App's advanced settings,
or deploy by hand afterwards), Control's maintenance pass and the mail relay (IAM's sign-in and invitation mail) stop
with it.

1. **Prepare** a checkout of the installation's release (the tag in the sidecar's `fabrika.ref`) with `bun install`,
   Control's database URL in a file `control-db-url`
   ([Reaching Control's database on Zerops](#reaching-controls-database-on-zerops)), and the current key from the
   secrets file:
   `( set -a && . <secrets file> && set +a && printf '%s' "$FABRIKA_CONTROL_VAULT_KEY" ) > vault-key.old`.
2. **Generate the new key:** `head -c 32 /dev/urandom | base64 > vault-key.new`. It is base64, not base64url.
3. **Back up the database:** `zops backup create db`. That backup opens only with the current key.
4. **Stop Control:** `zops service stop control`.
5. **Run the rotation:**

   ```bash
   FABRIKA_CONTROL_VAULT_KEY="$(cat vault-key.old)" FABRIKA_CONTROL_VAULT_KEY_NEW="$(cat vault-key.new)" \
     FABRIKA_CONTROL_DATABASE_URL="$(cat control-db-url)" bun run --cwd <checkout>/packages/control rotate-vault-key
   ```

   It ends with `complete: every vault row opens with the new key and none with the current one` and exit 0.
6. **Give Control the new key**, delete-and-create as for IAM's keys, without a restart (Control is stopped):

   ```bash
   zops env unset FABRIKA_CONTROL_VAULT_KEY control
   zops env set FABRIKA_CONTROL_VAULT_KEY - control --sensitive < vault-key.new
   ```

   Then replace the `FABRIKA_CONTROL_VAULT_KEY='…'` line of the secrets file with the new key.
7. **Start Control:** `zops service start control`. Check: step 5's command with `--check` appended ends `complete`
   (it writes nothing), and a deploy of an environment that holds vault keys succeeds.
8. **Keep the old key** in `vault-key.old` for as long as `db` keeps backups taken before step 5: they open only with
   it. Then destroy it.

### An interrupted run

- **The run stopped (lost connection, killed process, refused row):** the transaction did not commit, so every row is
  still under the current key and Control has not been given the new one. `--check` shows it. Run step 5 again.
- **A row neither key opens:** the run refuses before writing anything and names the row ids. When every row is
  counted so, `vault-key.old` is not the key Control runs with. Such a row was sealed
  under a third key or altered in the database. Find out which before you delete anything: a value Control cannot open
  is lost either way.
- **Control ran with the old key after the run committed** (started before step 6): it can open no vault row, so its
  deploys fail, and every value it wrote then is under the old key. `--check` counts those rows under the current key.
  Stop Control, run step 5 again (it re-wraps only those rows), then continue at step 6.
- **Control runs with the new key and `--check` at step 7 still counts rows under the old one:** stop Control and run
  step 5 again; nothing in step 6 changes.

## Reaching Control's database on Zerops

Control's database is the `db` service's: `FABRIKA_CONTROL_DATABASE_URL` of `control` is
`${db_connectionTlsString}/${db_dbName}?sslmode=require`. Connect your machine to the project's private network with
`zcli vpn up <project id>`, read `connectionTlsString` and `dbName` of `db` in the Zerops GUI, and write
`<connectionTlsString>/<dbName>?sslmode=require` to `control-db-url`. `psql "$(cat control-db-url)"` runs the SQL above.
UNVERIFIED: this path has not been run against a live Zerops installation; the script itself is tested against
Postgres (`packages/control/src/__tests__/rotate-vault-key.test.ts`).
