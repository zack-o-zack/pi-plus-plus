# pi-plus-plus

An empty [Pi](https://pi.dev) extension package.

## Use locally

```sh
pi --extension ./src/index.ts
```

Or add this directory to Pi's `extensions` setting.

## Contributing and releases

Install dependencies and validate the package with:

```sh
npm install --ignore-scripts
npm run check
```

For a user-facing change, create a changeset and describe the SemVer impact:

```sh
npm run changeset
```

The release workflow opens a release pull request from changesets on `main`.
After that PR merges, the workflow publishes to npm, creates a `vX.Y.Z` tag,
and creates the corresponding GitHub release. Maintainers can run these commands
locally when necessary:

```sh
npm run version
npm run release
```

Publishing requires the repository secret `NPM_TOKEN`, an npm access token that
can publish `pi-plus-plus`. Without it, the workflow creates release pull
requests but does not publish to npm.
