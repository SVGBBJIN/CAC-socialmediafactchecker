# Credentials

No API key appears in source, in a diff, or in a build log. This document explains how
that is arranged, and — just as importantly — what it does not achieve.

## ⚠️ Rotate the Gemini key

The Gemini API key for this project was shared in a chat message during handoff. **Treat
it as compromised and rotate it** at
<https://aistudio.google.com/apikey>. Anything pasted into a chat log, a ticket or an
email should be assumed to be recoverable.

While you're there, restrict the replacement: in Google Cloud console, scope the key to
the Generative Language API only, and set a quota cap. A leaked key with a cap costs
money once; a leaked unrestricted key costs money until someone notices.

## The honest version of "encrypt the key"

An iOS app that calls Gemini directly must be able to produce that key at runtime with no
user input. Everything needed to do so therefore ships inside the app. **Any client-side
scheme is obfuscation, not secrecy** — it raises the cost of extraction, it does not
prevent it. Anyone claiming otherwise is selling something.

What the scheme here actually buys, which is worth having:

- The plaintext key is never committed, so it never leaks through the repo, a fork, a
  screenshot of a diff, or CI logs.
- It is not recoverable by unzipping the IPA and running `strings`, which is how key
  leaks are actually found at scale.
- Rotating a key is a resource swap, not a code change and release.

**The real fix is to not ship provider keys at all.** Put a thin backend in front of
Gemini and Groq that holds the provider keys and authenticates the app. The device then
carries a revocable per-install token, and a compromise costs one user's access rather
than the account's whole quota. `ChainedSecretStore` is shaped so this is a configuration
change: point it at a store that fetches the short-lived token, drop
`EncryptedSecretsBundle` from the chain, done.

## How it works today

Three layers, tried in order by `ChainedSecretStore`:

```
Keychain  →  encrypted bundle  →  environment / Info.plist
(cached)     (shipped)             (debug only)
```

1. **Keychain** (`KeychainSecretStore`) — where the key lives after first use. Written
   with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: *AfterFirstUnlock* because
   the share extension can run on a locked device, *ThisDeviceOnly* so the key never
   rides an iCloud Keychain sync or an encrypted backup to another device. Use a Keychain
   access group so the app and the share extension share one item.

2. **Encrypted bundle** (`EncryptedSecretsBundle`) — `secrets.enc`, an AES-256-GCM sealed
   box shipped as a bundle resource. The unwrap key is derived with HKDF-SHA256 from a
   32-byte seed that is stored as two XOR halves in generated Swift, salted with the
   bundle identifier so the blob can't be lifted into another app. Authenticated
   encryption, so a tampered blob fails rather than decrypting to garbage.

3. **Environment / Info.plist** (`EnvironmentSecretStore`) — the development path.
   `Secrets.xcconfig` (gitignored) feeds build settings into `Info.plist`. Convenient for
   debug builds; plaintext in the bundle, so **never ship a build that relies on it**.

## Provisioning

```bash
# 1. Write the plaintext locally. Gitignored — never commit it.
cat > Secrets.env <<'EOF'
GEMINI_API_KEY=<your rotated key>
GROQ_API_KEY=<your groq key>
EOF

# 2. Produce the encrypted blob and the generated seed.
swift run seer-secrets encrypt \
    --salt com.yourteam.seer \
    --in Secrets.env \
    --out Seer/Resources/secrets.enc \
    --swift-out Seer/Generated/SecretsSeed.swift

# 3. Add secrets.enc to the app target's Copy Bundle Resources phase.
# 4. Delete Secrets.env, or keep it out of any synced folder.
```

`--salt` must match the salt used at runtime. `EncryptedSecretsBundle`'s bundle-loading
initialiser defaults to the bundle identifier, so pass your real bundle id.

The tool verifies the round trip before reporting success — a blob that can't be opened
fails at provisioning time rather than at app launch.

| File | Commit? |
|---|---|
| `Secrets.env` | **No** — gitignored |
| `secrets.enc` | **No** — gitignored |
| `SecretsSeed.swift` | **Yes** — decrypts nothing on its own |

## Wiring it up

```swift
let keychain = KeychainSecretStore(accessGroup: "group.com.yourteam.seer")

let secrets = ChainedSecretStore(
    stores: [
        keychain,
        try EncryptedSecretsBundle(keySeed: GeneratedSecretsSeed.seed),
        EnvironmentSecretStore(),   // drop this from release builds
    ],
    cachingInto: keychain           // unwrap once per install, not once per share
)

let pipeline = SeerPipelineBuilder.makePipeline(.init(secrets: secrets))
```

## Enforcement

`SecretStoreTests.testNoCredentialsAreCommittedToSource` walks the committed tree and
fails the build if anything shaped like a Google (`AIza…`), Groq (`gsk_…`) or OpenAI
(`sk-…`) key appears in a source, config or docs file. It runs with the normal test suite.
