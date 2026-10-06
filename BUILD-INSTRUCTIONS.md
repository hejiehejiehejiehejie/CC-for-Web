# Build instructions — for AMO source review

This file is part of the source package attached to the add-on submission. It
describes how to reproduce the submitted package from this source tree.

## What the submitted package is

`CC for Web` is an independent, MIT-licensed fork of
[Competitive Companion](https://github.com/jmerle/competitive-companion) by
Jasper van Merle. The submitted file is the **Firefox** build of this repository.

## Build environment

This is the environment the submitted package was actually built in.

| Item | Version / value |
| --- | --- |
| Operating system | macOS 27.0 (build 26A428), arm64 (Apple Silicon) |
| Node.js | v24.16.0 |
| npm | 11.13.0 (bundled with that Node.js release) |
| pnpm | used to install dependencies; `pnpm-lock.yaml` is `lockfileVersion: 9.0`, so pnpm 9 or newer |
| `tsx` | 4.22.4 |
| `esbuild` | 0.28.1 |
| `typescript` | 6.0.3 |

There is no native compilation step. Every dependency is pure JavaScript or
TypeScript, and the only platform-specific binaries are esbuild's prebuilt ones,
which the package manager selects automatically for your platform. Building on
Linux or Windows therefore works the same way.

## Reproduce the build

A pnpm lockfile is committed, so the dependency tree is pinned.

```bash
pnpm install --frozen-lockfile
pnpm build:firefox
```

If pnpm is not installed yet:

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

`build-firefox/` is then exactly the directory that was zipped and submitted.

The package scripts are thin wrappers; the same build without pnpm:

```bash
node node_modules/tsx/dist/cli.mjs scripts/build/extension.ts firefox true false
```

The three arguments are `target`, `isProduction`, `watch`. `firefox true false` is
the combination that produced the submitted package: `isProduction=true` enables
minification, `watch=false` makes it a one-shot build.

## Why the submitted bundle is minified

Bundling and minification are done by esbuild with `minifyWhitespace` and
`minifySyntax` enabled, which is why the submitted package contains
machine-generated JavaScript. There is no obfuscation, and no build step is
missing from this tree — the bundle is a plain bundling of `src/`, with the one
exception below.

## The one place the build modifies dependency code

`scripts/build/utils.ts` registers an esbuild plugin called
`remove-dangerous-code`. While bundling, it rewrites three constructs inside two
vendored dependencies, `jszip` and `pdfjs-dist`:

| From | To |
| --- | --- |
| `new Function(` | `new Error(` |
| `await import(this.workerSrc)` | `null` |
| `export{... as WorkerMessageHandler};` | *(removed)* |

These substitutions exist to clear `web-ext lint` warnings about dynamic code
evaluation. They touch code paths this add-on never calls; the parts of `jszip`
and `pdfjs-dist` that Competitive Companion actually uses are unaffected.

Dependency versions at the time of the build:

- `jszip` 3.10.1
- `pdfjs-dist` 4.2.67

Grepping either package for the "to" column above shows exactly the substituted
call sites.

## Tree layout

| Path | Contents |
| --- | --- |
| `src/` | extension source (TypeScript) |
| `scripts/build/` | build and packaging |
| `scripts/` | asset generation and dev launchers |
| `tests/` | Jest specs for the problem parsers |
| `media/` | icons and store graphics |
| `CHANGELOG.md` | version history (inherited from upstream) |
| `SUBMISSION-EDGE.md` | notes kept for the Edge store submission |