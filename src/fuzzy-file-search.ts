/**
 * Tiny fuzzy file-path matcher.
 *
 * Matches every character of the (lowercased) query against the path in order,
 * scoring matches that fall on word boundaries and consecutive runs higher.
 * Designed for typeahead UX over a few-thousand-entry file list — runs in
 * O(query × path) per file and keeps allocations minimal.
 *
 * The scoring is deliberately simple. It is not VSCode-tier. It is good
 * enough that "ldrnd" finds "src/nodes/LeaderNode.tsx" before
 * "src/some/folder/learnedfromredundance.ts".
 */

export interface FuzzyMatch {
  path: string;
  score: number;
  /** Indices in `path` of each matched query character, in query order. */
  indices: number[];
}

const WORD_BOUNDARY = /[\\/_\-.\s]/;

/**
 * Match `query` against `path`. Returns null if any query character is not
 * present in order. Empty queries return a zero-score match (caller decides
 * what to do with that).
 */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  if (query.length === 0) {
    return { path, score: 0, indices: [] };
  }

  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const indices: number[] = [];
  const lastSlash = p.lastIndexOf("/");

  let qi = 0;
  let pi = 0;
  let score = 0;
  let prevMatched = false;

  while (qi < q.length && pi < p.length) {
    if (q[qi] === p[pi]) {
      // Boundaries: start of string, after a separator, or camelCase hump
      // (lower → upper transition in the *original* path).
      const prevChar = pi > 0 ? p[pi - 1]! : "";
      const isStart = pi === 0;
      const afterSep = pi > 0 && WORD_BOUNDARY.test(prevChar);
      const camelHump =
        pi > 0 &&
        path[pi]! >= "A" && path[pi]! <= "Z" &&
        path[pi - 1]! >= "a" && path[pi - 1]! <= "z";

      let bonus = 1;
      if (prevMatched) bonus += 10;
      if (isStart || afterSep || camelHump) bonus += 5;
      if (lastSlash >= 0 && pi > lastSlash) bonus += 2; // matched char lives in basename

      score += bonus;
      indices.push(pi);
      qi++;
      prevMatched = true;
    } else {
      prevMatched = false;
    }
    pi++;
  }

  if (qi < q.length) return null;

  // Big bonus when every match landed in the basename — that's almost always
  // what the user means.
  if (lastSlash >= 0 && indices.length > 0 && indices[0]! > lastSlash) {
    score += 15;
  }

  // Mild bias against very long paths so when scores tie the shorter wins.
  score -= Math.floor(p.length / 50);

  return { path, score, indices };
}

/**
 * Score every candidate, drop non-matches, sort by score (then by path length
 * as a stable tiebreaker), and slice to `limit`.
 */
export function fuzzySearchFiles(
  query: string,
  files: readonly string[],
  limit = 50,
): FuzzyMatch[] {
  if (query.length === 0) return [];
  const matches: FuzzyMatch[] = [];
  for (const f of files) {
    const m = fuzzyMatch(query, f);
    if (m) matches.push(m);
  }
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.length - b.path.length;
  });
  return matches.slice(0, limit);
}
