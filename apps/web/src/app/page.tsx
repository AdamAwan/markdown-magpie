const pipelineItems = [
  "Sync Markdown repo",
  "Index heading sections",
  "Answer with citations",
  "Cluster gaps",
  "Propose pull requests"
];

export default function HomePage() {
  return (
    <main className="shell">
      <section className="header">
        <div>
          <p className="eyebrow">Markdown Magpie</p>
          <h1>Git-backed knowledge that notices what is missing.</h1>
        </div>
        <a className="button" href="/api/health">
          Health
        </a>
      </section>

      <section className="panel">
        <h2>Maintenance Loop</h2>
        <div className="pipeline">
          {pipelineItems.map((item) => (
            <div className="step" key={item}>
              {item}
            </div>
          ))}
        </div>
      </section>

      <section className="grid">
        <div>
          <h2>Current MVP</h2>
          <p>
            Connect one Markdown repository, index docs, answer questions with citations, record weak answers, and
            raise pull requests for proposed fixes.
          </p>
        </div>
        <div>
          <h2>Deployment Bias</h2>
          <p>
            Docker first and provider-neutral. Azure is the preferred managed path only when a concrete cloud provider
            is needed.
          </p>
        </div>
      </section>
    </main>
  );
}
