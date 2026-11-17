# Release Policy

## Compatible semantic versions

All public `@borecount/*` packages share the same `major.minor` compatibility line.
Patch versions are independent: `postgres-adapter@0.8.1` works with `core@0.8.0`,
`http@0.8.0` and the route adapters at `0.8.0`. Publish a new patch only for a
changed package. OpenAPI `info.version` matches the HTTP package version.

Before `1.0.0`, a breaking public contract change increments the minor version.
After `1.0.0`, it increments the major version. New ledger or HTTP functionality
increments the minor version. A change to the compatibility line updates all
public packages together. Backward-compatible fixes and installation, packaging,
or operator tooling improvements use a patch of the affected package, including
an additive migration-path export that exposes unchanged SQL. A database
migration follows the impact of the behavior or contract it supports.

Public contract includes exported TypeScript names and subpaths, HTTP requests,
responses and errors, OpenAPI, persisted schema and migration expectations, and
documented ledger behavior. Correcting behavior that contradicted an invariant
is a fix only when the old behavior was neither documented nor safe to rely on.

Internal dependency ranges declare the minimum supported patch in the same
compatibility line. Do not raise them when that minimum has not changed. Use
`^0.8.0` for the `0.8` line; use `~1.2.0` for a future `1.2` line, since `^1.2.0`
also admits other minor versions. Consumers commit their lockfiles and may upgrade
individual patches within one line. Mixing different major/minor lines is unsupported.

## Breaking changes and deprecations

A breaking change must be called out under `Unreleased` in `CHANGELOG.md`, in
the versioned release notes, and in an upgrade section with an integrator action.
When safety permits, deprecated APIs remain available for at least one minor
release and produce a documented replacement before removal. Security or ledger
correctness issues may require immediate removal; the release notes must explain
the exception and mitigation.

The `0.6.0` Borecount rename is a direct cutover: no old-name aliases, dual
publishing, deprecation notices or compatibility window are required. This
exception does not authorize deleting old published artifacts.

## Tags and publication

- Each package independently selects its npm tag: stable versions use `latest`;
  prereleases use `next`. One run may publish both kinds.
- Independent package releases use Git tags `<package-directory>-v<version>` and
  notes `docs/releases/<package-directory>-<version>.md`, for example
  `postgres-adapter-v0.8.1`. This avoids collisions when another package later
  reaches the same patch. Legacy coordinated `v<version>` tags and notes remain valid.
- Create Git tags and GitHub releases only after the selected versions are visible in npm.
- npm publication runs from `main` in the `Release` GitHub Actions workflow, using
  trusted publishing/OIDC and `--provenance`.

Release verification generates a manifest containing each package's own version,
tarball, release notes and tag. The workflow carries that manifest alongside the
verified tarballs, checks npm for each exact version, and publishes only missing
versions in dependency order. Before skipping an existing version, it downloads the
published tarball and compares its filenames and file bytes with the candidate, ignoring
archive timestamps, compression and entry order. A difference fails the entire preflight
and requires a version bump; no package is published before every check passes.
Already published packages and their dist-tags stay unchanged. Registry/authentication
errors fail the release rather than counting as a missing version. The final smoke test installs the exact mixed-patch set.

## Release checklist

1. Update changed package versions, their notes, and `CHANGELOG.md`. Update internal
   minimum ranges only if required; update OpenAPI only with the HTTP version.
   Change all package versions together when changing `major.minor`.
2. Document breaking changes, deprecations, idempotency changes, and operator
   migration steps. For schema changes, follow the [migration verification
   policy](../integration/versioning.md#upgrade-verification).
3. Pass unit and PostgreSQL integration tests, lint, typecheck, build,
   `contract:verify`, `release:verify`, `migration:verify`, and `pack:verify`.
4. Run `Release` with publication disabled. Inspect its manifest, tarballs and
   verified npm publication plan.
5. Run the workflow with publication enabled; tags are selected per package.
6. Confirm changed versions and provenance in npm; create their package tags and
   GitHub releases from their versioned notes.
7. Upgrade consumers, regenerate their lockfiles, and verify their integrations.

## Recovery

Published npm versions are immutable. If publication stops part way, rerun the
same workflow; already published versions are skipped. If an incorrect artifact
was published, deprecate it and release a new patch of the affected package.
Never overwrite a tag or attempt to reuse a version.
