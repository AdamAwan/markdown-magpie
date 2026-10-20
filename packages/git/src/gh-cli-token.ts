import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GH_AUTH_TOKEN_TIMEOUT_MS = 5_000;

// Where the process's GITHUB_TOKEN came from after hydration: already set in the
// environment, read from the GitHub CLI's login, or not available at all.
export type GithubTokenSource = "env" | "gh-cli" | "none";

// Runs `gh auth token` and returns its stdout. Injectable so tests don't depend
// on a real gh install or login.
type GhTokenReader = () => Promise<string>;

async function readGhCliToken(): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
    timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
    windowsHide: true
  });
  return stdout;
}

// Lets a developer who has run `gh auth login` skip creating a PAT: when
// GITHUB_TOKEN is unset, borrow the GitHub CLI's token for github.com and put it
// in the environment, so every existing GITHUB_TOKEN reader (git auth headers, PR
// calls, the watcher's `github` capability gate) picks it up unchanged. Call once
// at process startup, before config is loaded. An explicit GITHUB_TOKEN always
// wins; MAGPIE_GH_CLI_AUTH=false opts out. A missing `gh`, no login, or a timeout
// all resolve to "none" — the app then runs without GitHub auth, as before.
export async function hydrateGithubTokenFromGhCli(
  env: NodeJS.ProcessEnv = process.env,
  readToken: GhTokenReader = readGhCliToken
): Promise<GithubTokenSource> {
  if (env.GITHUB_TOKEN?.trim()) {
    return "env";
  }
  if (env.MAGPIE_GH_CLI_AUTH?.trim().toLowerCase() === "false") {
    return "none";
  }
  let token: string;
  try {
    token = (await readToken()).trim();
  } catch {
    return "none";
  }
  if (!token) {
    return "none";
  }
  env.GITHUB_TOKEN = token;
  return "gh-cli";
}
