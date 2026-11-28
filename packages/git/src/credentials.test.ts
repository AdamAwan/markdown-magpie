import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  embeddedHttpsCredentials,
  hasEmbeddedHttpCredentials,
  redactCredentials,
  stripUrlCredentials
} from "./credentials.js";

describe("stripUrlCredentials", () => {
  it("drops user:password and token-as-username userinfo from http(s) urls", () => {
    assert.equal(
      stripUrlCredentials("https://x-access-token:ghp_secret@github.com/a/b.git"),
      "https://github.com/a/b.git"
    );
    assert.equal(stripUrlCredentials("https://ghp_secret@github.com/a/b.git"), "https://github.com/a/b.git");
    assert.equal(stripUrlCredentials("http://u:p@git.example.com:8080/x.git"), "http://git.example.com:8080/x.git");
  });

  it("returns a credential-free url byte-for-byte unchanged", () => {
    for (const url of [
      "https://github.com/a/b.git",
      "https://GitHub.com/a/b",
      "git@github.com:a/b.git",
      "/srv/repos/docs.git",
      "file:///srv/repos/docs.git"
    ]) {
      assert.equal(stripUrlCredentials(url), url);
    }
  });

  it("keeps the ssh username (not a secret) but drops an ssh password", () => {
    assert.equal(stripUrlCredentials("ssh://git@github.com/a/b.git"), "ssh://git@github.com/a/b.git");
    assert.equal(stripUrlCredentials("ssh://git:hunter2@host/a.git"), "ssh://git@host/a.git");
  });
});

describe("embedded credentials", () => {
  it("are only extracted from https urls, percent-decoded", () => {
    assert.deepEqual(embeddedHttpsCredentials("https://user:p%40ss@github.com/a.git"), {
      username: "user",
      password: "p@ss"
    });
    assert.equal(embeddedHttpsCredentials("http://user:pass@github.com/a.git"), undefined);
    assert.equal(embeddedHttpsCredentials("ssh://git:pw@github.com/a.git"), undefined);
    assert.equal(embeddedHttpsCredentials("https://github.com/a.git"), undefined);
  });

  it("are detected on http and https alike", () => {
    assert.equal(hasEmbeddedHttpCredentials("http://user:pass@host/a.git"), true);
    assert.equal(hasEmbeddedHttpCredentials("https://tok@host/a.git"), true);
    assert.equal(hasEmbeddedHttpCredentials("https://host/a.git"), false);
    assert.equal(hasEmbeddedHttpCredentials("ssh://git@host/a.git"), false);
  });
});

describe("redactCredentials", () => {
  it("redacts userinfo of http(s) urls inside git error text", () => {
    const message =
      "Command failed: git clone -- https://x-access-token:ghp_secret@github.com/a/b.git /tmp/x\n" +
      "fatal: unable to access 'https://ghp_other@github.com/a/b.git/': The requested URL returned error: 403";
    const redacted = redactCredentials(message);
    assert.doesNotMatch(redacted, /ghp_secret|ghp_other/);
    assert.match(redacted, /https:\/\/\*\*\*@github\.com\/a\/b\.git \/tmp\/x/);
  });

  it("redacts a user:password pair on any scheme but keeps a bare ssh username", () => {
    assert.equal(redactCredentials("ssh://git:pw@host/a.git"), "ssh://***@host/a.git");
    assert.equal(redactCredentials("ssh://git@host/a.git"), "ssh://git@host/a.git");
  });

  it("redacts echoed authorization header values", () => {
    assert.equal(
      redactCredentials("> Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hw\n"),
      "> Authorization: Basic ***\n"
    );
    assert.equal(redactCredentials("Authorization: Bearer ghp_x"), "Authorization: Bearer ***");
  });
});
