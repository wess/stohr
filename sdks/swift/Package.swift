// swift-tools-version:6.4
import PackageDescription

let package = Package(
    name: "Stohr",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15), .watchOS(.v9)],
    products: [
        .library(name: "Stohr", targets: ["Stohr"]),
    ],
    targets: [
        .target(name: "Stohr"),
        .testTarget(name: "StohrTests", dependencies: ["Stohr"]),
    ]
)
