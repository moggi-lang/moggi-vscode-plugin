# Moggi Language Support for VS Code

A thin VS Code client for the Moggi language server. The extension contains no
compiler code: it locates an installed Moggi distribution and starts its
language server through the distribution's launcher (`bin/moggi`, or
`bin/moggi.exe` on Windows) as `moggi lsp`.

The launcher carries the compiler and its own PHP runtime, so the machine
running VS Code needs neither a compiler checkout nor a PHP installation.

## Features

- **Language Server Protocol (LSP)**: hover, go-to-definition/references,
  completion, signature help, document/workspace symbols, rename, formatting,
  semantic tokens, inlay hints, folding, call/type hierarchy, and more
- **Moggi: Run Current File**: compile and run the active `.mog` file via
  `moggi run` in a terminal
- **Compile task**: `moggi compile <folder> -o <folder>/out` as a VS Code task
  (with a `$moggi` problem matcher for compiler diagnostics)
- **Test Explorer**: run `.mog` fixtures through `moggi run` from the Testing
  view

## Requirements

A Moggi distribution, unpacked anywhere. Download the archive for your platform
from the [releases page](https://github.com/moggi-lang/moggi/releases)
(`moggi-php-<version>-<platform>.tar.gz`, or `.zip` on Windows), unpack it, and
either

- put `bin/moggi` on your `PATH`, or
- keep it inside your workspace (the extension looks for `bin/moggi` in each
  workspace folder), or
- set `moggi.path` to the launcher, its `bin` directory, or the installation
  root.

Unpack with `tar xzf` on Linux/macOS so the launcher keeps its executable bit.
Nothing else needs to be installed: the distribution runs on the runtime it
ships.

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `moggi.path` | string | `""` | Moggi launcher (`bin/moggi` / `bin/moggi.exe`), its `bin` directory, or the distribution root. Empty = look for one in the workspace folders, then on `PATH` |
| `moggi.trace.server` | string | `"off"` | Trace LSP communication: "off", "messages", or "verbose" |
| `moggi.inlayHints` | boolean | `false` | Show inferred type inlay hints |
| `moggi.libPaths` | array | `[]` | Extra library roots passed to the server as `--lib` flags |
| `moggi.testRoot` | string | `""` | Directory of `.mog` fixtures for Test Explorer, relative to the workspace folder (empty = `tests/backend/runtime`) |
| `moggi.backend` | string | `"php"` | Backend for the compile task and Run command (`php`, `jvm`, `dotnet`) |

## Language Server

The extension starts the launcher in language-server mode when a `.mog` file is
opened, and stops it when VS Code closes. The server resolves the compiler, the
standard library and its bundled runtime from the distribution, so the process'
working directory is the workspace being edited.

Commands:

- `Moggi: Restart Language Server`
- `Moggi: Show Output`
- `Moggi: Run Current File`

The status bar shows the server state; hovering it names the launcher in use.

> Note: the compiler shells out to the tools of the backend it compiles for
> (JVM/.NET), which come from the caller's `PATH`. The launcher puts the
> distribution's bundled runtimes in front of it, so the PHP backend always
> works; a `jvm`/`dotnet` build needs a GraalVM / .NET SDK installed, and VS
> Code has to be able to see it.

## Formatting (experimental — postponed)

> **Note:** Moggi does not have a real code formatter yet. The language
> server's document/range/on-type formatting is a minimal tidier (whitespace,
> blank-line collapsing, signature-preserving output) and is considered
> **experimental**. A dedicated Moggi formatter is a prerequisite for
> format-on-save and reliable range formatting; until then, treat formatting
> results as a best-effort preview. Formatter work is postponed until the
> language ships a proper formatter.

## Syntax Highlighting

`syntaxes/moggi.tmLanguage.json` provides baseline highlighting (comments,
strings, keywords, numbers) while the semantic-token stream from the language
server loads and covers identifiers and types.

## Development

The extension is built with [bun](https://bun.sh) (not npm/node):

```bash
bun install
bun run compile     # tsc -p ./
bun run typecheck   # tsc --noEmit
bun run e2e         # protocol-level E2E against a real distribution
```

Package a `.vsix` with `bun run package` (`@vscode/vsce` is a dev dependency).

### End-to-end tests

The E2E script (`scripts/e2e-lsp.mjs`) speaks raw Content-Length framed
JSON-RPC over stdio with the real server — the same transport
vscode-languageclient uses — driving the distribution's `bin/moggi` exactly as
the extension does. No PHP and no compiler checkout are involved.

It uses a local distribution when there is one — the path argument,
`MOGGI_LAUNCHER`, `compiler/bin/moggi` inside this repository, or a distribution
unpacked beside it — and otherwise downloads the compiler release this plugin
targets:

```bash
bun run e2e                                      # fetch the pinned release, unpack to .dist/, run it
MOGGI_LAUNCHER=/path/to/bin/moggi bun run e2e    # or use a local build
MOGGI_COMPILER_VERSION=<release tag> bun run e2e    # or another release
MOGGI_DIST_URL=<dev-build archive url> bun run e2e   # or a development build
bun run fetch-dist                               # just fetch it, printing the launcher path
bun run fetch-dist --force                       # fetch it again, replacing .dist/
```

Downloads land in `.dist/<version>/<platform>/` (gitignored) and are reused, since
a release never changes. A `--url`/`MOGGI_DIST_URL` archive is fetched every run
instead: a development build is a moving target.

**The compiler version this plugin is tested against lives in
`scripts/fetch-dist.mjs`** (`COMPILER_VERSION`, `0.1.0-alpha` today). Bump that
constant when the extension needs behaviour from a newer compiler; it is the
only place the version appears, locally and in CI.

The fixtures are this repository's own (`fixtures/lsp/`), copied into a
throwaway workspace per run. A distribution ships no test data, and a contract
test should not reach into the other repository's tests.

### Debugging E2E failures

1. Check server stderr output (prefixed with `[server-stderr]`)
2. Run the launcher manually to see raw JSON-RPC:
   ```bash
   <dist>/bin/moggi lsp < /dev/null
   ```

### Publishing to the VS Code Marketplace

The Marketplace is free for publishers and free for users to install from.

1. Create a publisher at <https://marketplace.visualstudio.com/manage>. The
   extension id becomes `<publisher>.<name>` — `moggi.moggi-lsp` for this one,
   which is why `publisher` in `package.json` has to match an existing
   publisher.
2. Create a Personal Access Token with the **Marketplace > Manage** scope (Azure
   DevOps → user settings → Personal access tokens, organisation "all accessible
   organisations"; the publisher page also links to it). PATs expire, so this has
   to be renewed.
3. Publish:
   ```bash
   bunx @vscode/vsce login moggi        # paste the PAT once, it is stored for `vsce`
   bunx @vscode/vsce publish            # bumps nothing: publishes the package.json version
   bunx @vscode/vsce publish --packagePath moggi-lsp-0.1.0.vsix
   ```
   Every publish needs a version that is not on the Marketplace yet, so bump
   `version` in `package.json` first.
4. From CI, put the same token in the repository secret `VSCE_PAT`: the
   `release` workflow publishes the tagged version to the Marketplace when that
   secret is set (and still attaches the `.vsix` to the GitHub release either
   way).

The Marketplace does not accept pre-release versions such as `0.1.0-alpha`, so
the extension version is a plain `X.Y.Z`; publish a pre-release channel with
`vsce publish --pre-release` instead if you need one.

## Project Structure

```
├── src/extension.ts                # Thin LSP client + tasks/run/test explorer
├── scripts/e2e-lsp.mjs             # LSP protocol E2E tests
├── scripts/fetch-dist.mjs          # Pinned compiler version; downloads a distribution
├── fixtures/lsp/                   # The .mog inputs those tests own
├── syntaxes/moggi.tmLanguage.json  # TextMate grammar (baseline highlighting)
├── language-configuration.json     # Brackets, comments, indentation
├── media/                          # Icons
└── package.json                    # Extension manifest
```

The language server implementation itself lives in the compiler repository
([moggi-lang/moggi](https://github.com/moggi-lang/moggi)) under `src/lsp/`.
