# Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant Microsoft the rights to use your contribution. For details, visit https://cla.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the pull request appropriately. Follow the instructions provided by the bot. You only need to do this once across all repositories using Microsoft's CLA process.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with questions or concerns.

## Before You Start

- Search existing issues before opening a new one.
- Open an issue before starting large changes so the scope and direction can be discussed.
- Keep changes focused and include tests when behavior changes.

## Development Setup

1. Install [Node.js](https://nodejs.org/) 22 or later.
2. Install dependencies.
3. Run formatting, linting, and tests before opening a pull request.

```bash
npm install
npm run build
npm run lint
npm test
```

### Using package-lock.json

The committed `package-lock.json` is generated through Microsoft's package proxy.
Microsoft contributors are required to use this proxy so dependencies undergo
the required security and vulnerability policies. The lockfile can contain
registry and tarball URLs that are inaccessible outside Microsoft.

If you cannot access the proxy, generate a replacement lockfile for local use
with an accessible npm registry. Changing `--registry` alone on the existing
lockfile does not reliably replace recorded custom-registry tarball URLs; regenerate
the lockfile rather than manually editing those URLs.

Start in a fresh checkout without `node_modules`, or move the existing root
`node_modules` directory outside the checkout first. This prevents reuse of
installed packages and the hidden `node_modules/.package-lock.json`. Back up any
local lockfile changes, then remove only the root `package-lock.json` (using your
file manager or shell). From the repository root, generate and use a local
lockfile, for example with the public npm registry:

```bash
npm install --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org/
npm ci --registry=https://registry.npmjs.org/
```

The first command resolves dependencies from `package.json` without installing
them; the second installs the generated lockfile normally. Scoped registry
settings, if configured, must also point to registries you can access.
Resolved versions may differ from the committed lockfile because of dependency
ranges and registry availability, including quarantine policies; this does not
guarantee the same dependency tree. Microsoft contributors must continue using
the required proxy rather than using this workflow to bypass its restrictions.

## Pull Requests

- Describe the problem and the approach clearly.
- Link related issues when applicable.
- Update documentation when public behavior or setup changes.
- Keep the repository planning and README documents aligned with the implementation.
