// Pure, deterministic "model" logic behind the golden provider fixture
// (scripts/fixtures/golden-provider.mjs). It emulates an ideal obedient model
// for the three calls the answer_question pipeline makes — flow routing, the
// assess/answer loop turn, and the grounding-verification pass — as a pure
// function of the request text, so a golden-eval run is exactly reproducible.
//
// The one deliberate exception to "obedient": a question mentioning SOC 2 makes
// the answer turn append a fabricated compliance claim the context does not
// support. That is the golden set's probe of the grounding-verification
// machinery — the verify turn (which stays honest) must flag and strip it.

// Words carried by question phrasing rather than content. Includes the framing
// words golden questions use; anything not listed counts as a content word a
// section must cover.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "be", "by", "can", "do", "does", "for", "from",
  "how", "i", "in", "into", "is", "it", "my", "of", "on", "or", "our", "per",
  "should", "that", "the", "this", "to", "was", "we", "were", "what", "when",
  "where", "which", "who", "why", "will", "with", "you", "your"
]);

// Lowercase alphanumeric tokens; hyphenated words ("on-call", "eu-west") stay
// one token so they match the docs verbatim.
export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []).map(lightStem);
}

// Naive plural folding so "clusters" covers "cluster" (and vice versa). Only
// a trailing "s" — anything smarter risks nondeterministic surprises.
function lightStem(token) {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

export function contentWords(text) {
  return tokenize(text).filter((token) => !STOPWORDS.has(token));
}

// Clauses split ONLY on ", and " — the golden set uses that exact separator for
// multi-part questions, and a bare " and " would tear apart ordinary phrases.
export function splitClauses(question) {
  return question
    .split(/,\s+and\s+/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

// Parses the "[section <id>] # <heading>\n<content>" blocks the watcher renders
// into the assess/verify context. Section content may itself contain blank
// lines, so blocks are delimited by the next "[section " label, not by "\n\n".
export function parseSections(context) {
  const sections = [];
  const pattern = /\[section ([^\]]+)\] # ([^\n]*)\n?/g;
  let match = pattern.exec(context);
  while (match) {
    const start = pattern.lastIndex;
    const next = context.indexOf("[section ", start);
    const end = next === -1 ? context.length : next;
    sections.push({
      id: match[1],
      heading: match[2].trim(),
      content: context.slice(start, end).trim()
    });
    pattern.lastIndex = end;
    match = next === -1 ? null : pattern.exec(context);
  }
  return sections;
}

// Fraction of the clause's content words present in the section (heading +
// content). 1 means the section covers every content word.
export function clauseCoverage(clause, section) {
  const words = contentWords(clause);
  if (words.length === 0) {
    return 0;
  }
  const sectionTokens = new Set([...tokenize(section.heading), ...tokenize(section.content)]);
  const hit = words.filter((word) => sectionTokens.has(word)).length;
  return hit / words.length;
}

// Best fully-covering section for a clause, preferring context order (which is
// retrieval order — deterministic). Returns undefined when no section covers
// every content word of the clause.
export function coveringSection(clause, sections) {
  return sections.find((section) => clauseCoverage(clause, section) >= 1);
}

export function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

// The sentences of a section that share at least one content word with the
// clause, in document order — the grounded raw material for an answer.
export function groundedSentences(clause, section) {
  const words = new Set(contentWords(clause));
  return splitSentences(section.content).filter((sentence) =>
    tokenize(sentence).some((token) => words.has(token))
  );
}

// ---------------------------------------------------------------------------
// Routing turn
// ---------------------------------------------------------------------------

// Parses the chat-router user message ("Question:\n…\n\nFlows:\n<json>") and
// picks the flow whose name+persona shares the most content words with the
// question. Zero overlap everywhere, or a tie at the top, abstains (flowId
// null) — the honest router behaviour the pipeline turns into
// flow-selection-required.
export function routeCall(userMessage) {
  const question = extractLabelled(userMessage, "Question:", "Flows:");
  const flowsJson = userMessage.slice(userMessage.indexOf("Flows:") + "Flows:".length).trim();
  let flows;
  try {
    flows = JSON.parse(flowsJson);
  } catch {
    return { flowId: null, confidence: "low", rationale: "golden fixture: unparseable flows" };
  }
  const questionWords = new Set(contentWords(question));
  const scored = flows.map((flow) => {
    const flowTokens = new Set(contentWords(`${flow.name ?? ""} ${flow.persona ?? ""}`));
    let overlap = 0;
    for (const word of questionWords) {
      if (flowTokens.has(word)) {
        overlap += 1;
      }
    }
    return { id: flow.id, overlap };
  });
  scored.sort((left, right) => right.overlap - left.overlap);
  const [best, runnerUp] = scored;
  if (!best || best.overlap === 0 || (runnerUp && runnerUp.overlap === best.overlap)) {
    return { flowId: null, confidence: "low", rationale: "golden fixture: no flow clearly matches" };
  }
  return { flowId: best.id, confidence: "high", rationale: "golden fixture: keyword overlap" };
}

// ---------------------------------------------------------------------------
// Assess/answer turn
// ---------------------------------------------------------------------------

const FORCED_ANSWER_DIRECTIVE = "Answer now using only the context above";
const PERSONA_LABEL = "Persona (how to look and respond):";
export const FABRICATED_SOC2_CLAIM = "Aurora is fully SOC 2 certified and audit-approved.";
const NOT_COVERED_PREFIX = "The knowledge base does not cover:";

// One assess turn: given the system prompt (for the persona) and the user
// message (question + accumulated context), decide to search or answer —
// deterministically. Returns the JSON-serialisable reply object.
export function assessCall(systemPrompt, userMessage) {
  const question = extractLabelled(userMessage, "Question:", "Context:");
  const context = userMessage.slice(userMessage.indexOf("Context:") + "Context:".length);
  const forced = context.includes(FORCED_ANSWER_DIRECTIVE);
  const sections = parseSections(context);
  const clauses = splitClauses(question);

  const covered = clauses
    .map((clause) => ({ clause, section: coveringSection(clause, sections) }))
    .filter((entry) => entry.section !== undefined);
  const uncovered = clauses.filter((clause) => !covered.some((entry) => entry.clause === clause));

  // Nothing in the whole context touches the question, and the question shares
  // no vocabulary with the flow's persona: off-topic for this knowledge area.
  if (covered.length === 0 && isOffTopic(systemPrompt, question, sections)) {
    return answerReply({
      answer: "This question is not about this knowledge base's subject area.",
      confidence: "low",
      outOfScope: true
    });
  }

  // Something is still missing and we are allowed to search: ask for exactly
  // the uncovered clauses' content words. The loop bounds the rounds, so
  // repeating an unsatisfied search is safe and records the emptiness.
  if (uncovered.length > 0 && !forced) {
    return {
      action: "search",
      queries: uncovered.map((clause) => contentWords(clause).join(" ")),
      rationale: "golden fixture: uncovered clause(s)"
    };
  }

  if (covered.length === 0) {
    return answerReply({
      answer: `${NOT_COVERED_PREFIX} ${clauses.join("; ")}.`,
      confidence: "low",
      isKnowledgeGap: true,
      gaps: clauses
    });
  }

  const answerSentences = [];
  const usedSectionIds = [];
  for (const { clause, section } of covered) {
    for (const sentence of groundedSentences(clause, section)) {
      if (!answerSentences.includes(sentence)) {
        answerSentences.push(sentence);
      }
    }
    if (!usedSectionIds.includes(section.id)) {
      usedSectionIds.push(section.id);
    }
  }
  // The deliberate embellishment probe: a SOC 2 question gets an unsupported
  // marketing claim appended, which the verify turn must strip.
  if (/soc\s*2/i.test(question)) {
    answerSentences.push(FABRICATED_SOC2_CLAIM);
  }
  const followupGaps = uncovered.map((clause) => `${clause} (not covered by the knowledge base)`);
  if (uncovered.length > 0) {
    answerSentences.push(`${NOT_COVERED_PREFIX} ${uncovered.join("; ")}.`);
  }
  return answerReply({
    answer: answerSentences.join(" "),
    confidence: uncovered.length > 0 ? "medium" : "high",
    followupGaps,
    usedSectionIds
  });
}

function answerReply(overrides) {
  return {
    action: "answer",
    answer: "",
    confidence: "low",
    isKnowledgeGap: false,
    outOfScope: false,
    gaps: [],
    followupGaps: [],
    usedSectionIds: [],
    ...overrides
  };
}

// Off-topic = the question shares no content word with the flow persona (from
// the system prompt) AND no content word with any retrieved section. In-domain
// but uncovered questions overlap the persona and become knowledge gaps.
function isOffTopic(systemPrompt, question, sections) {
  const questionWords = new Set(contentWords(question));
  const personaStart = systemPrompt.indexOf(PERSONA_LABEL);
  if (personaStart !== -1) {
    const persona = systemPrompt.slice(personaStart + PERSONA_LABEL.length).split("\n\n")[0];
    if (contentWords(persona).some((word) => questionWords.has(word))) {
      return false;
    }
  }
  return !sections.some((section) =>
    [...tokenize(section.heading), ...tokenize(section.content)].some((token) => questionWords.has(token))
  );
}

// ---------------------------------------------------------------------------
// Grounding-verification turn
// ---------------------------------------------------------------------------

// Honest verifier: every sentence of the answer under review must appear
// verbatim (whitespace-normalised) in a full context section. Meta-statements
// about coverage ("The knowledge base does not cover…") are not factual claims
// and pass. Unsupported sentences are stripped into a revised answer.
export function verifyCall(userMessage) {
  const answer = extractLabelled(userMessage, "Answer under review:", "Context:");
  const context = userMessage.slice(userMessage.indexOf("Context:") + "Context:".length);
  const sectionsText = normalise(parseSections(context).map((section) => section.content).join(" "));

  const supported = [];
  const unsupported = [];
  for (const sentence of splitSentences(answer)) {
    if (sentence.startsWith(NOT_COVERED_PREFIX) || sectionsText.includes(normalise(sentence))) {
      supported.push(sentence);
    } else {
      unsupported.push(sentence);
    }
  }
  if (unsupported.length === 0) {
    return { grounded: true, unsupportedClaims: [] };
  }
  return {
    grounded: false,
    unsupportedClaims: unsupported,
    revisedAnswer:
      supported.length > 0 ? supported.join(" ") : "The knowledge base does not cover this question."
  };
}

function normalise(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Text between two labels (label text excluded), used to pull the question /
// answer out of the structured user messages the pipeline sends.
function extractLabelled(message, startLabel, endLabel) {
  const start = message.indexOf(startLabel);
  const end = message.indexOf(endLabel);
  if (start === -1) {
    return "";
  }
  const from = start + startLabel.length;
  return (end === -1 ? message.slice(from) : message.slice(from, end)).trim();
}
