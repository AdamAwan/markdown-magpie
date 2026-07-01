import Link from "next/link";
import { Citation, ConsoleNotice } from "../lib/types";

export function AttentionPanel({ notices }: { notices: ConsoleNotice[] }) {
  return (
    <section className="attentionPanel" aria-label="System notices">
      {notices.map((notice) => (
        <article className={`attentionNotice ${notice.tone}`} key={notice.id}>
          <div>
            <h2>{notice.title}</h2>
            <p>{notice.body}</p>
          </div>
          {notice.action && notice.actionLabel ? (
            <button className="chip" onClick={notice.action} type="button">
              {notice.actionLabel}
            </button>
          ) : null}
        </article>
      ))}
    </section>
  );
}

export function NavButton({
  active,
  count,
  glyph,
  label,
  href
}: {
  active: boolean;
  count?: number;
  glyph: string;
  label: string;
  href: string;
}) {
  return (
    <Link
      className={active ? "navButton active" : "navButton"}
      href={href}
      title={`Open ${label}`}
      aria-current={active ? "page" : undefined}
    >
      <span className="navGlyph">{glyph}</span>
      <span>{label}</span>
      {count === undefined ? null : (
        <span className="pill" title={`${count} ${label.toLowerCase()} item${count === 1 ? "" : "s"}`}>
          {count}
        </span>
      )}
    </Link>
  );
}

export function CitationRow({ citation }: { citation: Citation }) {
  return (
    <div className="citation">
      <div className="citationTop">
        <strong>{citation.heading}</strong>
        <code>{citation.sectionId}</code>
        <span className="citationRelevance" title="Retrieval relevance">
          {Math.round(citation.relevance * 100)}%
        </span>
      </div>
      <span>
        {citation.path}
        {citation.anchor ? `#${citation.anchor}` : ""}
      </span>
      <p>{citation.excerpt}</p>
    </div>
  );
}

// A small pill naming the knowledge flow a question, gap, or cluster belongs to,
// so reviewers can see at a glance which audience/destination it routes to.
// Renders nothing for un-routed (legacy) items; falls back to the raw id when the
// flow is no longer configured.
export function FlowTag({ flowId, flowLabels }: { flowId?: string; flowLabels: Record<string, string> }) {
  if (!flowId) {
    return null;
  }
  return (
    <span className="pill flowPill" title={`Knowledge flow: ${flowLabels[flowId] ?? flowId}`}>
      {flowLabels[flowId] ?? flowId}
    </span>
  );
}

export function ContextValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="contextValue">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
