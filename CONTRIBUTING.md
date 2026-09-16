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

### Registry-neutral lockfile

The root `.npmrc` sets `omit-lockfile-registry-resolved=true`. Use npm 10.9.2
or later so normal `npm install` and dependency updates omit registry tarball
URLs from `package-lock.json`, without overriding your configured registry.
Commit the lockfile alongside intentional dependency changes.

Omitting these URLs preserves locked versions and integrity hashes; it does not
change the dependency graph or remove non-registry resolutions such as Git,
file, or direct tarball URLs. Use `npm ci` to install the locked dependencies
through your configured registry. If a locked version is unavailable there
(for example, while quarantined), installation fails rather than downgrading.
Wait for availability or follow your registry's approved process; this option
does not bypass quarantine. Published-library consumers resolve `package.json`
ranges independently of this repository's lockfile.

## Pull Requests

- Describe the problem and the approach clearly.
- Link related issues when applicable.
- Update documentation when public behavior or setup changes.
- Keep the repository planning and README documents aligned with the implementation.
