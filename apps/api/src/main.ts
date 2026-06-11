import { createServer } from "node:http";
import { MockChatProvider, answerQuestion } from "@magpie/retrieval";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "markdown-magpie-api" }));
    return;
  }

  if (request.method === "POST" && request.url === "/ask") {
    const payload = await readJsonBody<{ question?: string }>(request);
    const result = await answerQuestion(
      payload.question ?? "",
      {
        async search() {
          return [];
        }
      },
      new MockChatProvider()
    );

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, () => {
  console.log(`Markdown Magpie API listening on http://localhost:${port}`);
});

async function readJsonBody<T>(request: NodeJS.ReadableStream): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
