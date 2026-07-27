// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Seer",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        // Platform-agnostic pipeline: models, the extractor fork, Gemini + Whisper
        // clients, secrets. Pure Foundation so it builds and tests anywhere.
        .library(name: "SeerCore", targets: ["SeerCore"]),
        // iOS-only capture implementations (WKWebView + RPScreenRecorder).
        .library(name: "SeerCapture", targets: ["SeerCapture"]),
        // Dev-machine tool that produces the encrypted secrets blob.
        .executable(name: "seer-secrets", targets: ["SeerSecretsTool"]),
    ],
    dependencies: [
        // Apple platforms use CryptoKit from the SDK; this only supplies the same API
        // on Linux so the crypto path stays testable in CI.
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0"),
    ],
    targets: [
        .target(
            name: "SeerCore",
            dependencies: [
                .product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux])),
            ]
        ),
        .target(name: "SeerCapture", dependencies: ["SeerCore"]),
        .executableTarget(name: "SeerSecretsTool", dependencies: ["SeerCore"]),
        .testTarget(name: "SeerCoreTests", dependencies: ["SeerCore"]),
    ]
)
