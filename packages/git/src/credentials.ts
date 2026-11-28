// Credential hygiene for git remote URLs (docs/threat-model.md TM36–TM38).
//
// An operator may configure a credential-embedded remote such as
// `https://x-access-token:ghp_…@github.com/acme/docs.git`. Handed to git verbatim,
// that secret is written into `.git/config` as the origin URL, echoed back in every
// git error message (which reaches logs, job errors and the console), re-read by the
// indexer as the repository's `remoteUrl`, and served by GET /api/knowledge/repositories.
// These helpers keep the secret out of every one of those places: the URL git is
// given (and stores) is the credential-free form, and the embedded credential — when
// it is safe to send at all — travels only as an `http.extraheader` in the child's
// environment (see buildGitAuthEnv in index.ts).

// The userinfo an https remote carries, decoded. Present only for `https:` URLs:
// credentials are never sent over plain http, ssh, git or file transports.
export interface EmbeddedCredentials {
  username: string;
  password: string;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value.trim());
  } catch {
    // scp-like ssh (`git@host:path`) and bare filesystem paths are not URLs; neither
    // can carry a password.
    return undefined;
  }
}

function decode(component: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}

// Returns `url` with any secret userinfo removed, unchanged when there is none (so a
// clean URL is never re-serialised and compares byte-for-byte with what was given).
// For `ssh://` only the password is dropped — the ssh username (`git@`) selects the
// account the key authenticates and is not a secret. Every other scheme loses its
// whole userinfo: on https/http the username position is routinely the token itself
// (`https://ghp_…@github.com/…`).
export function stripUrlCredentials(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed || (!parsed.username && !parsed.password)) {
    return url;
  }
  if (parsed.protocol === "ssh:") {
    if (!parsed.password) {
      return url;
    }
    parsed.password = "";
    return parsed.toString();
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

// True when `url` is an http(s) remote that carries userinfo — i.e. git would send
// (and store) a credential that is part of the URL itself.
export function hasEmbeddedHttpCredentials(url: string): boolean {
  const parsed = parseUrl(url);
  return Boolean(
    parsed && (parsed.protocol === "https:" || parsed.protocol === "http:") && (parsed.username || parsed.password)
  );
}

// The decoded userinfo of an `https:` remote, or undefined for any other scheme or a
// URL without userinfo. Never returned for `http:` — that would put the secret on
// the wire in clear text.
export function embeddedHttpsCredentials(url: string): EmbeddedCredentials | undefined {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== "https:" || (!parsed.username && !parsed.password)) {
    return undefined;
  }
  return { username: decode(parsed.username), password: decode(parsed.password) };
}

// `scheme://userinfo@` inside free text. http(s) userinfo is always a secret (the
// username position is often the token); for any other scheme only a `user:password`
// pair is treated as one, so `ssh://git@host` stays readable.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/@'"`<>]+)@/gi;
// An HTTP authorization value echoed in text (e.g. a GIT_TRACE line or a header
// dumped into an error): keep the scheme word, drop the credential.
const AUTH_HEADER = /\b(Authorization:\s*)(Basic|Bearer|token)\s+[^\s'"`]+/gi;

// Redacts credentials from any text built from git output, git argv, or a remote
// URL before it is put in an Error, a log line or an API response.
export function redactCredentials(text: string): string {
  return text
    .replace(URL_USERINFO, (match, scheme: string, userinfo: string) => {
      const lower = scheme.toLowerCase();
      if (lower === "http" || lower === "https" || userinfo.includes(":")) {
        return `${scheme}://***@`;
      }
      return match;
    })
    .replace(AUTH_HEADER, (_match, prefix: string, kind: string) => `${prefix}${kind} ***`);
}
