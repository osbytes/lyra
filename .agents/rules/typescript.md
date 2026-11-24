# TypeScript rules

Enforced by `tsconfig*.json` (`strict`, `noImplicitAny`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) and `eslint.config.mjs`
(typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`, plus no casts, exhaustive
switches, no `console`, and no `process.env` outside `src/main/config.ts`). If a rule here and the tooling disagree, the tooling wins: fix the code,
not the config.

## No `any`

- **Never** write `any`, `as any`, `Array<any>`, `Record<string, any>`, or `Function`.
  (`@typescript-eslint/no-explicit-any`)
- Values whose type you don't control are `unknown`: IPC payloads, `JSON.parse`, `require()` of
  native addons, `catch` variables, `fetch` bodies, files read from disk.
- Narrow `unknown` before use with type guards, `typeof`/`instanceof`/`Array.isArray`, or a
  validator function. Don't let an implicit `any` leak through (`no-unsafe-*` rules).

```ts
// Bad
const data = JSON.parse(raw)          // any
const settings = data as Settings     // unchecked

// Good
const data: unknown = JSON.parse(raw)
const settings = sanitize(data, defaults)  // validates field by field
```

- Need to describe a third-party shape we don't have types for? Declare a minimal `type` for the
  parts we use, and assert at the single place the value enters our code.

## No escape hatches

- No non-null assertions (`value!`). Check and handle the missing case, or restructure so the
  type is already non-null. (`no-non-null-assertion`)
- No `@ts-ignore` / `@ts-nocheck`. `@ts-expect-error` only with a description of why.
- No `as` casts (`consistent-type-assertions`, `assertionStyle: never`; `as const` is fine).
  Narrow with a type guard, `instanceof`, a validator or a declared type instead. Files listed in
  `CAST_BASELINE` in `eslint.config.mjs` still hold older casts: take a file off the list once
  its casts are gone, and never add one.
- `eslint-disable-next-line <rule>` only with a comment on the line above explaining why the rule
  is wrong in this spot. Never disable a rule file-wide.

## Indexing and nullability

- `noUncheckedIndexedAccess` is on: `arr[i]` and `record[key]` are `T | undefined`. Prefer
  `for…of`, destructuring with defaults (`const [first = ''] = parts`), `.at()`, or an explicit
  check.
- Use `??` for defaults, not `||`, unless an empty string or `0` should also fall back (then say so
  or use a ternary).
- Use optional chaining (`a?.b`) instead of `a && a.b`.

## Types

- Prefer `type` aliases over `interface` (`consistent-type-definitions`). Exception: augmenting a
  global like `Window`, which needs interface merging.
- Model states as discriminated unions (`{ state: 'idle' } | { state: 'error'; message: string }`),
  not optional-field bags.
- String literal unions over `enum`.
- A `switch` over a union lists every member (`switch-exhaustiveness-check`); no catch-all
  `default`, so a new member is a compile-time decision, not a silent fall-through.
- Annotate exported function return types. Let TypeScript infer locals.
- Shared cross-process types live in `src/shared/types.ts`.
- `import type` for type-only imports (`consistent-type-imports`).

## Async

- Every promise is awaited, returned, or explicitly discarded with `void` — no floating promises.
  (`no-floating-promises`)
- Don't pass async functions where a void callback is expected without handling rejection.
  (`no-misused-promises`)
- `catch (error)` and `.catch((error: unknown) => …)`: treat `error` as `unknown`; use
  `error instanceof Error ? error.message : String(error)`.

## React (renderer)

- Hooks follow `rules-of-hooks`; `exhaustive-deps` is an error — fix dependencies rather than
  disabling the rule. Use refs for values read inside long-lived callbacks.
- Components are typed functions with a `Props` type; no `React.FC`.
- Side effects that return cleanup (subscriptions, timers) always return it from `useEffect`.

## Naming and style

- `camelCase` values/functions, `PascalCase` types/components, `SCREAMING_SNAKE_CASE` module
  constants.
- Small, single-purpose functions. Extract a function when a block needs a comment to explain it.
- No dead code, no commented-out code, no `console.*` outside the logging modules.
- Configuration comes from `config()` (`src/main/config.ts`), never `process.env`; a new variable
  goes in `src/main/envSpec.ts` and `pnpm config:docs` regenerates `docs/CONFIG.md`.
