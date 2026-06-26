# Beautiful Mermaid Data Flow Renderer

This Swift package renders Markdown Magpie's Data Flow Mermaid sources through
[`lukilabs/beautiful-mermaid-swift`](https://github.com/lukilabs/beautiful-mermaid-swift).

## Requirements

- Swift 5.9+
- macOS 12+ for the renderer executable

## Usage

From the repository root:

```bash
npm run dataflow:export
npm run dataflow:render:swift
```

The exporter writes `.mmd` sources to `apps/web/public/dataflow/mermaid`.
The Swift renderer writes SVG files to `apps/web/public/dataflow/svg`.

You can also pass explicit paths:

```bash
cd tools/beautiful-mermaid-dataflow
swift run DataFlowRenderer --input ../../apps/web/public/dataflow/mermaid --output ../../apps/web/public/dataflow/svg
```
