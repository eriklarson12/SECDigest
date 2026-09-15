# API contract check

`src/lib/types.ts` is a hand-written mirror of `backend/app/models/schemas.py`. This directory
is what proves it is still accurate (roadmap 11.3).

```bash
cd backend && python -m scripts.dump_openapi ../frontend/openapi.json
cd frontend && npm run contract
```

CI runs the same two commands across two jobs: `backend` dumps the schema and uploads it,
`contract` downloads it and checks it.

## How it works

`map.mjs` relates the two sides and is the only file to edit by hand. `npm run contract` then

1. fails if any backend component schema is neither in `SCHEMA_MAP` nor in `UNMAPPED`,
2. generates `generated.ts` from the schema with `openapi-typescript`,
3. emits `assert.ts`, one `Exact<DeepRequired<...>>` assertion per mapped pair,
4. type-checks the pair with `tsconfig.contract.json`.

`generated.ts` and `assert.ts` are gitignored and are **never imported by application code**.
`types.ts` stays the hand-written source the app imports, because its JSDoc is real
documentation that codegen would destroy.

**Optionality is not compared; null-ness is.** FastAPI marks a field optional whenever the
Pydantic model gives it a default, which describes input defaulting rather than response
serialization — `filing_date: str | None = None` is always present as `null` on the wire. So
both sides are wrapped in `DeepRequired` before comparison, and `string | null` vs `string`
still fails. The recursion matters: four responses nest models whose fields are optional on the
generated side alone, and a shallow `Required<>` would pass them vacuously.

**Paths and methods are deliberately out of scope.** `lib/api.ts` builds URLs from templates,
so matching them against OpenAPI path patterns is string-matching guesswork. Schemas are where
the silent breakage lives.

## Re-run these three whenever the mechanism changes

A gate nobody has watched go red is not known to work. All three were verified on 2026-09-15.

| Break | Expected |
| --- | --- |
| Add a field to a Pydantic response model, leave `types.ts` alone | Fails naming that type |
| Change a `types.ts` field from `string \| null` to `string` | Fails naming that type and its container |
| Add a Pydantic model reachable from an endpoint, map it nowhere | Coverage check fails, before `tsc` runs |

Re-dump `openapi.json` after any backend edit, or the check reads a stale schema.

## Two ways this gate can go quiet

- **`any` in `types.ts`** satisfies `Exact` in both directions. `@typescript-eslint/no-explicit-any`
  is an error under `eslint-config-next/typescript`, which is what keeps it out.
- **`exclude` is inherited through `extends`.** `tsconfig.contract.json` restates it, because the
  base config excludes `generated.ts` and `assert.ts` to keep them out of `next build` — and an
  inherited `exclude` beats `include`, which made the check pass while type-checking nothing.
