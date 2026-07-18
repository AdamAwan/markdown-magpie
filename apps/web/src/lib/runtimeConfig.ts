// Serializes the runtime config object for injection into an inline <script>
// tag (see app/layout.tsx). `JSON.stringify` alone does not escape `<`, so a
// config value containing the literal substring `</script>` could terminate
// the inline script element early and inject arbitrary markup/script into the
// page (a classic HTML-context script-injection). Config values are
// operator-controlled env today, not user input, so this isn't currently
// exploitable -- but we harden it anyway since the config is rendered as raw
// HTML via `dangerouslySetInnerHTML`.
//
// Escaping `<` -> `\u003c` neutralizes `</script>` (and any other tag) while
// still round-tripping through `JSON.parse` to the original value, since
// `\uXXXX` is a valid JSON/JS string escape. U+2028/U+2029 (line/paragraph
// separators) are also escaped: they're valid in JSON strings but are raw
// line terminators in JS, which can break script parsing outside of a JSON
// string context. The regex literals below use \u escape sequences (not the
// raw characters) so this source file itself stays plain ASCII.
export function serializeRuntimeConfig(config: unknown): string {
  return JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
