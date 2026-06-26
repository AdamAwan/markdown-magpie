// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BeautifulMermaidDataFlow",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "DataFlowRenderer", targets: ["DataFlowRenderer"])
    ],
    dependencies: [
        .package(url: "https://github.com/lukilabs/beautiful-mermaid-swift", from: "1.0.0")
    ],
    targets: [
        .executableTarget(
            name: "DataFlowRenderer",
            dependencies: [
                .product(name: "BeautifulMermaid", package: "beautiful-mermaid-swift")
            ]
        )
    ]
)
