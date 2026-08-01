/**
 * Section-level search over the ingested corpus.
 *
 * Whole-document hits are close to useless to an agent — `memory.md` alone is
 * 2,500 lines — so documents are split at markdown headings (and at exported
 * declarations for TypeScript contracts) and scored per section. Ranking is
 * BM25 with one deliberate addition: a document's authority rank from
 * `docs/README.md` biases the score, so canonical material surfaces early and a
 * near-tie breaks toward it.
 *
 * The bias is intentionally mild. Authority order governs which document wins a
 * *disagreement*, not which one is the better answer to a question — a detail
 * document is often the more relevant match for a detail question, and burying
 * it under the architecture overview would make the tool worse.
 */

import type { KnowledgeDocument } from "./corpus.js";

export interface Section {
  documentId: string;
  documentTitle: string;
  relativePath: string;
  authority: number;
  /** Heading path, e.g. `Rendering and frame delivery > Frame header`. */
  heading: string;
  /** 1-based line where this section starts, for citation. */
  startLine: number;
  text: string;
}

export interface SearchHit extends Section {
  score: number;
  /** Excerpt around the best-matching line. */
  snippet: string;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how", "i", "if", "in",
  "into", "is", "it", "its", "of", "on", "or", "that", "the", "their", "then", "there", "these",
  "this", "to", "was", "what", "when", "where", "which", "who", "why", "will", "with", "you"
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** Splits markdown at ATX headings, carrying the heading trail for context. */
function splitMarkdown(document: KnowledgeDocument): Section[] {
  const rows = document.text.split(/\r?\n/);
  const sections: Section[] = [];
  const trail: string[] = [];
  let buffer: string[] = [];
  let currentHeading = document.title;
  let startLine = 1;
  let inFence = false;

  const flush = (endExclusive: number): void => {
    const text = buffer.join("\n").trim();
    if (text) {
      sections.push({
        documentId: document.id,
        documentTitle: document.title,
        relativePath: document.relativePath,
        authority: document.authority,
        heading: currentHeading,
        startLine,
        text
      });
    }
    buffer = [];
    startLine = endExclusive + 1;
  };

  rows.forEach((row, index) => {
    if (/^\s*```/.test(row)) inFence = !inFence;
    const heading = inFence ? null : row.match(/^(#{1,6})\s+(.*)$/);

    if (heading) {
      flush(index);
      const depth = heading[1].length;
      trail.length = Math.max(0, depth - 1);
      trail[depth - 1] = heading[2].trim();
      currentHeading = trail.filter(Boolean).join(" > ") || document.title;
      startLine = index + 1;
      buffer.push(row);
      return;
    }

    buffer.push(row);
  });

  flush(rows.length);
  return sections;
}

/**
 * Splits a TypeScript contract at top-level exported declarations, keeping the
 * preceding doc comment with its declaration — the comment is usually where the
 * reason for a field lives, and separating them loses exactly the part worth
 * reading.
 */
function splitTypeScript(document: KnowledgeDocument): Section[] {
  const rows = document.text.split(/\r?\n/);
  const sections: Section[] = [];
  let buffer: string[] = [];
  let currentHeading = document.title;
  let startLine = 1;

  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (text) {
      sections.push({
        documentId: document.id,
        documentTitle: document.title,
        relativePath: document.relativePath,
        authority: document.authority,
        heading: currentHeading,
        startLine,
        text
      });
    }
    buffer = [];
  };

  rows.forEach((row, index) => {
    const declaration = row.match(
      /^export\s+(?:declare\s+)?(?:abstract\s+)?(interface|type|function|const|class|enum)\s+([A-Za-z0-9_$]+)/
    );

    if (declaration) {
      // Pull a doc comment immediately above this line into the new section.
      let commentStart = buffer.length;
      while (commentStart > 0 && /^\s*(\/\*\*|\*|\*\/|\/\/)/.test(buffer[commentStart - 1])) {
        commentStart -= 1;
      }
      const carried = buffer.splice(commentStart);
      flush();
      buffer = carried;
      startLine = index + 1 - carried.length;
      currentHeading = `${declaration[1]} ${declaration[2]}`;
    }

    buffer.push(row);
  });

  flush();
  return sections;
}

export function sectionsFor(document: KnowledgeDocument): Section[] {
  const sections = document.relativePath.endsWith(".ts")
    ? splitTypeScript(document)
    : splitMarkdown(document);

  // A section longer than this drowns the snippet; split it on blank lines so a
  // long uninterrupted block still ranks at a useful granularity.
  const MAX_SECTION_CHARS = 6000;
  return sections.flatMap((section) => {
    if (section.text.length <= MAX_SECTION_CHARS) return [section];
    const parts: Section[] = [];
    let offset = 0;
    while (offset < section.text.length) {
      const slice = section.text.slice(offset, offset + MAX_SECTION_CHARS);
      const breakAt = slice.lastIndexOf("\n\n");
      const take = breakAt > MAX_SECTION_CHARS / 2 ? breakAt : slice.length;
      parts.push({ ...section, text: section.text.slice(offset, offset + take).trim() });
      offset += take;
    }
    return parts.filter((part) => part.text.length > 0);
  });
}

export class SearchIndex {
  private readonly sections: Section[];
  private readonly tokens: string[][];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(documents: KnowledgeDocument[]) {
    this.sections = documents.flatMap(sectionsFor);
    this.tokens = this.sections.map((section) => tokenize(`${section.heading} ${section.text}`));

    for (const sectionTokens of this.tokens) {
      for (const token of new Set(sectionTokens)) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
      }
    }

    const total = this.tokens.reduce((sum, sectionTokens) => sum + sectionTokens.length, 0);
    this.averageLength = this.tokens.length ? total / this.tokens.length : 1;
  }

  get sectionCount(): number {
    return this.sections.length;
  }

  search(query: string, limit: number, documentIds?: string[]): SearchHit[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const filter = documentIds?.length ? new Set(documentIds) : undefined;
    const K1 = 1.5;
    const B = 0.75;
    const hits: SearchHit[] = [];

    this.sections.forEach((section, index) => {
      if (filter && !filter.has(section.documentId)) return;

      const sectionTokens = this.tokens[index];
      if (sectionTokens.length === 0) return;

      const counts = new Map<string, number>();
      for (const token of sectionTokens) counts.set(token, (counts.get(token) ?? 0) + 1);

      let score = 0;
      for (const token of queryTokens) {
        const frequency = counts.get(token);
        if (!frequency) continue;
        const containing = this.documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + (this.tokens.length - containing + 0.5) / (containing + 0.5));
        const normalisation =
          frequency + K1 * (1 - B + (B * sectionTokens.length) / this.averageLength);
        score += idf * ((frequency * (K1 + 1)) / normalisation);
      }

      if (score <= 0) return;

      // Authority 1 (architecture.md) keeps its full score; each rank below it
      // gives up 8%. Enough to break ties toward the canonical document without
      // burying a detail document that is genuinely the better match.
      score *= 1 - Math.min(0.5, (section.authority - 1) * 0.08);

      hits.push({ ...section, score, snippet: snippetFor(section.text, queryTokens) });
    });

    return hits.sort((left, right) => right.score - left.score).slice(0, limit);
  }
}

/** Excerpt centred on the densest run of query terms. */
function snippetFor(text: string, queryTokens: string[], window = 700): string {
  if (text.length <= window) return text;

  const lowered = text.toLowerCase();
  let bestIndex = 0;
  let bestScore = -1;

  for (let start = 0; start < text.length; start += 120) {
    const slice = lowered.slice(start, start + window);
    const score = queryTokens.reduce(
      (sum, token) => sum + (slice.includes(token) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      bestIndex = start;
    }
  }

  const prefix = bestIndex > 0 ? "…" : "";
  const suffix = bestIndex + window < text.length ? "…" : "";
  return `${prefix}${text.slice(bestIndex, bestIndex + window).trim()}${suffix}`;
}
