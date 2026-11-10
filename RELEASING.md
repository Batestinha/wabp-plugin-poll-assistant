# Releasing

Release only with the **Release standalone plugin** workflow (Actions, then Run workflow, with the full commit SHA on `main`), never from a workstation.

- It builds in the pinned Fedora 44 container (`zlib-ng-compat-2.3.3-3.fc44`), runs the tests, builds the archive twice, checks that it loads outside the repository, then creates `v<version>` at that commit with the archive attached. The WABS index entry points at that asset, with its SHA-256.
- The archive's tar bytes are reproducible everywhere, but its gzip bytes depend on the zlib implementation (stock zlib and zlib-ng compress differently). That is why the builder is pinned, and why `validate.yml` builds in the same container.
- For a version that is already installed somewhere, pass that archive's SHA-256 as `expected_sha256`. WABP refuses a version whose bytes change ("already names different immutable bytes"), so the release must carry exactly those bytes.
- A local `npm run release:archive` is for testing. Its output names the `zlib` it used, and it reproduces the release bytes only with the same one (Fedora 44 prints `1.3.1.zlib-ng`).
- Bump the version in `package.json`, `package-lock.json` (twice), `wa-plugin.json` and `src/manifest.ts` before releasing changed content. Anything in the package's `files` list, including `README.md`, changes the archive.
