---
name: Integration lib dist is gitignored
description: Why a freshly added/restored composite lib package breaks downstream typecheck with TS6305, and how to fix it.
---

# Composite lib `dist/` declarations are gitignored

In this pnpm monorepo, the workspace lib packages are TypeScript **composite** projects
(`composite: true`, `emitDeclarationOnly`, `outDir: dist`). Their emitted `dist/*.d.ts`
declaration files are **gitignored** — they are NOT committed. They exist in the working
tree only because some build step (or the original author) generated them locally.

**Symptom:** When a lib package is added or restored from a backup/zip (which excludes
gitignored files), any package that references it via a TS project reference fails
typecheck with:

```
error TS6305: Output file '.../lib/<pkg>/dist/index.d.ts' has not been built from
source file '.../lib/<pkg>/src/index.ts'.
```

The runtime/deploy path is unaffected (api-server bundles from source via esbuild
`build.mjs`, not `tsc`), so the dev server and deploy work fine — only the `typecheck`
quality gate breaks.

**Fix:** emit the declarations with `pnpm exec tsc -b lib/<pkg>`. If `tsc -b` fails on
pre-existing type errors inside *unused* submodules of that package, fix only the genuine
errors blocking the build of the entry the consumer needs (e.g. null-guards like
`response.data?.[0]?.x`). Orphan packages referenced by nothing don't need building.

**Why:** dist is gitignored by repo convention (same as `lib/db`, `lib/api-zod` — their
dist is present in the tree but absent from `git ls-files`). A restore that only brings
back source will always be missing dist until rebuilt.

**How to apply:** after restoring or adding any `lib/*` composite package, run `tsc -b`
on it before trusting the downstream `typecheck` gate