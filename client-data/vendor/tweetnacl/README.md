# TweetNaCl.js 1.0.3

Bundled 2026-09-15 from the npm `tweetnacl@1.0.3` release for Ed25519 signing
and SHA-512 hashing on plain HTTP, where `crypto.subtle` is unavailable.

Upstream: https://github.com/dchest/tweetnacl-js

`nacl-fast.js`, `LICENSE`, and `AUTHORS.md` are unmodified release files.
`nacl-fast.d.ts` is the unmodified upstream `nacl.d.ts`, renamed to match the
bundled source. The small local `package.json` preserves CommonJS loading for
Node cross-implementation tests within WBO's ES-module client directory.
WBO loads the library as a classic browser script only when v2 signing or key
setup is needed. Biome excludes these upstream files from rewriting.

The npm release tarball SHA-1 is `ac0af71680458d8a6378d0d0d050ab1407d35596`.
Its SHA-512, verified against npm metadata over certificate-verified HTTPS, is
`6rt+RN7aOi1nGMyC4Xa5DdYiukl2UWCbcJft7YhxReBGQD7OAM8Pbxw6YMo4r2diNEA8FEmu32YOn9rhaiE5yw==`.
The code is dedicated to the public domain under the included LICENSE. All
Ed25519 public keys used for signing are derived locally from the private seed;
the signer never combines a private seed with a public key supplied by a server.
