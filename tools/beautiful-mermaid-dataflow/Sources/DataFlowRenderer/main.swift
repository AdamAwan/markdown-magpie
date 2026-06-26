import BeautifulMermaid
import Foundation

@main
struct DataFlowRenderer {
    static func main() throws {
        let arguments = CommandLine.arguments.dropFirst()
        let inputPath = value(after: "--input", in: arguments) ?? defaultRepoPath("apps/web/public/dataflow/mermaid")
        let outputPath = value(after: "--output", in: arguments) ?? defaultRepoPath("apps/web/public/dataflow/svg")

        let inputURL = URL(fileURLWithPath: inputPath).standardizedFileURL
        let outputURL = URL(fileURLWithPath: outputPath).standardizedFileURL
        let fileManager = FileManager.default

        try fileManager.createDirectory(at: outputURL, withIntermediateDirectories: true)

        let sourceFiles = try fileManager
            .contentsOfDirectory(at: inputURL, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "mmd" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        if sourceFiles.isEmpty {
            throw RendererError.noSources(inputURL.path)
        }

        for sourceFile in sourceFiles {
            let source = try String(contentsOf: sourceFile, encoding: .utf8)
            let svg = try MermaidRenderer.renderSVG(source: source, theme: .githubLight)
            let outputFile = outputURL.appendingPathComponent(sourceFile.deletingPathExtension().lastPathComponent)
                .appendingPathExtension("svg")

            try svg.write(to: outputFile, atomically: true, encoding: .utf8)
            print("Rendered \(sourceFile.lastPathComponent) -> \(outputFile.lastPathComponent)")
        }
    }

    private static func value(after flag: String, in arguments: ArraySlice<String>) -> String? {
        guard let index = arguments.firstIndex(of: flag) else {
            return nil
        }

        let valueIndex = arguments.index(after: index)
        guard valueIndex < arguments.endIndex else {
            return nil
        }
        return arguments[valueIndex]
    }

    private static func defaultRepoPath(_ relativePath: String) -> String {
        URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("..")
            .appendingPathComponent("..")
            .appendingPathComponent(relativePath)
            .standardizedFileURL
            .path
    }
}

enum RendererError: Error, CustomStringConvertible {
    case noSources(String)

    var description: String {
        switch self {
        case .noSources(let path):
            return "No .mmd files found in \(path). Run npm run dataflow:export first."
        }
    }
}
