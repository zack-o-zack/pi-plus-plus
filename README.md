# pi-plus-plus

An empty [Pi](https://pi.dev) extension package.

## Use locally

```sh
pi --extension ./src/index.ts
```

Or add this directory to Pi's `extensions` setting.

## Release

Install dependencies and validate the package with:

```sh
npm install --ignore-scripts
npm run check
```

Add release notes under `## Unreleased` in `CHANGELOG.md`, then run:

```sh
npm run version
npm run release
```

The GitHub Actions Release workflow performs these steps from `main`, commits
the release, and creates its tag and GitHub release.
