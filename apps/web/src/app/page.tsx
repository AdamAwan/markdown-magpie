import { redirect } from "next/navigation";
import { DEFAULT_SECTION_PATH } from "../lib/sections";

// The console has no dedicated landing view; the root path redirects to the
// default section so every view has a real, refresh-stable URL.
export default function IndexPage() {
  redirect(DEFAULT_SECTION_PATH);
}
