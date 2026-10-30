# Release notes for penfield

- **Lockstep.** The root `package.json` is authoritative, and every
  `packages/*/package.json` is bumped with it: `packages/penfield` now, and
  `packages/agent` once Stage B adds it. The ACP agent calls the service's
  `/route`, so the two ship as one version.
- **The first release is `/version minor`, at the end of Stage A** (spec step
  20 wants a CHANGELOG with 0.1.0). Everything before it is 0.0.0, and
  plumbbob's step commits are the history that first section summarizes.
- **verify is null on purpose.** The checkride scaffold excludes `CHANGELOG.md`
  from markdownlint and cspell, so no narrow check covers a release diff (version
  strings and changelog prose). The full `pnpm check` gate already runs at the
  end of every agent turn and in CI.
- **Nothing publishes on a tag,** so nothing is pushed. The packages are private
  and never go to npm, and CI runs the gate on pushes to `main` and on pull
  requests, never on tags. Push `main` and the tag by hand
  (`git push origin main vX.Y.Z`).
- **Deploying a release** is the playbook's §8: `git pull` and
  `docker compose … up -d --build` on plato, pinning an image tag per release so a
  rollback is by tag.
