import { redirect } from "next/navigation";
import { DEFAULT_SECTION_PATH } from "../lib/sections";

// The console has no dedicated landing view; the root path redirects to the
// default section so every view has a real, refresh-stable URL.
//
// Auth0's browser flow returns to the app origin (this route) with `?code` and
// `?state` in the query. A bare redirect to the default section would DROP those
// params, so the Auth0 SDK never sees the callback (hasAuthParams() is false at
// the destination), the code->token exchange never fires, and login silently
// fails. Forward any query string through the redirect so the SDK processes the
// callback at the destination route, then strips the params itself.
export default async function IndexPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      query.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        query.append(key, entry);
      }
    }
  }

  const queryString = query.toString();
  redirect(queryString ? `${DEFAULT_SECTION_PATH}?${queryString}` : DEFAULT_SECTION_PATH);
}
