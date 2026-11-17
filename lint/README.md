# Lint rules

Every demo's `src/` is held to one set of rules, in `.oxlintrc.json` at the repository root. The linter is [oxlint](https://oxc.rs/docs/guide/usage/linter.html) with type-aware rules. It lives in this directory, so no demo carries it as a dependency.

## Run it

```bash
cd lint
npm ci
npm run lint     # every demo's src/, and this directory
npm test         # the rules against their fixtures
```

The type-aware rules read each demo's types, so run `npm ci` in a demo before linting it. To lint one demo, from its directory:

```bash
PATH="$PWD/../lint/node_modules/.bin:$PATH" oxlint -c ../.oxlintrc.json --type-aware --deny-warnings src
```

CI runs that command in each demo's job. The step does not fail the job yet. The code that was here before the rules has findings, and they are fixed in later pull requests. When they are, remove `continue-on-error` from `.github/workflows/ci.yml`.

## What is checked

- oxlint's `correctness` and `suspicious` categories, as errors.
- Promises: `no-floating-promises` and `no-misused-promises`. A Worker that drops a promise loses the work when the request ends.
- Types: `no-explicit-any`, `no-non-null-assertion`, the `no-unsafe-*` rules, `switch-exhaustiveness-check`, and `consistent-type-imports`. The `no-unsafe-*` rules are off for `.mjs` and `.js` files, where nothing is typed.
- Imports: only a bridge's `src/backend.ts`, or the wrapper it owns, imports a vendor SDK.

Three rules are this repository's own, in this directory. Each encodes an invariant from `AGENTS.md`:

| Rule | Invariant |
|---|---|
| `switch-on-discriminant` | Branch on a discriminant such as `phase.kind` with a `switch`, so `switch-exhaustiveness-check` reports a new variant. An `if` chain sends a new variant into its last branch. TypeScript files only. |
| `paginate-v4-lists` | Do not use partial lists. A `list…` or `search…` call from `@shortcut/client/v4` that is awaited or read from yields one page. Pass it to `client.paginate(...)`. |
| `log-only-summaries` | Never log library errors whole. A caught error, or its `message`, `stack`, or `cause`, must not reach `console`. Log `summarizeShortcutV4Error(error)`, a status, a name, or an identifier-shaped code. |

## Add a rule

A rule earns its place when it would have caught a mistake that was made here.

1. Write the rule in `lint/<name>.mjs` and add it to `plugin.mjs`. Make its message say what to do instead.
2. Add at least one file under `fixtures/<name>/invalid/`, ideally the mistake itself, and one under `fixtures/<name>/valid/`.
3. Set `agent-demos/<name>` to `error` in `.oxlintrc.json`.
4. Run `npm test`. It fails for a rule that is not switched on, an invalid fixture that is not flagged, or a valid fixture that is.
