import Link from "next/link";
import { DEFAULT_SECTION_PATH } from "../lib/sections";

export default function NotFound() {
  return (
    <section className="workbench singlePane">
      <div className="surface">
        <div className="surfaceHeader">
          <h2>Page not found</h2>
        </div>
        <div className="surfaceBody">
          <p>That console section does not exist.</p>
          <Link className="button secondary" href={DEFAULT_SECTION_PATH}>
            Back to Ask
          </Link>
        </div>
      </div>
    </section>
  );
}
