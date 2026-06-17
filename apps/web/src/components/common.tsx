import { Citation, ConsoleNotice } from "../lib/types.js";

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

export function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function NavButton({
  active,
  count,
  glyph,
  label,
  onClick
}: {
  active: boolean;
  count?: number;
  glyph: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? "navButton active" : "navButton"} onClick={onClick} title={`Open ${label}`} type="button">
      <span className="navGlyph">{glyph}</span>
      <span>{label}</span>
      {count === undefined ? null : (
        <span className="pill" title={`${count} ${label.toLowerCase()} item${count === 1 ? "" : "s"}`}>
          {count}
        </span>
      )}
    </button>
  );
}

export function CitationRow({ citation }: { citation: Citation }) {
  return (
    <div className="citation">
      <div className="citationTop">
        <strong>{citation.heading}</strong>
        <code>{citation.sectionId}</code>
      </div>
      <span>
        {citation.path}
        {citation.anchor ? `#${citation.anchor}` : ""}
      </span>
      <p>{citation.excerpt}</p>
    </div>
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
