/**
 * Pt+En tokenizer + Jaccard similarity for BM25-ish dedup in the distill
 * pipeline. Intentionally small and deterministic — no external deps. Mirrors
 * the heuristics that ship with Jarvis's session-extract.js today so historical
 * dedup thresholds remain comparable.
 */

const PT_STOP = new Set(
  (
    'de a o e do da em um uma para com por que se no na os as dos das ao à ' +
    'isto isso ele ela eles elas mas ou como por quando onde quem seu sua ' +
    'este esta esse essa meu minha teu tua'
  ).split(/\s+/),
);

const EN_STOP = new Set(
  (
    'the a an is are was were be been has have had will would should could ' +
    'of in on at to for and or but not this that we i you he she they it ' +
    'from with by as do does did'
  ).split(/\s+/),
);

export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\w\sàáâãéêíóôõúç]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !PT_STOP.has(w) && !EN_STOP.has(w));
}

export function jaccardSimilarity(a, b) {
  if (!a?.length && !b?.length) return 0;
  const set1 = new Set(a);
  const set2 = new Set(b);
  let intersect = 0;
  for (const t of set1) if (set2.has(t)) intersect += 1;
  const union = new Set([...set1, ...set2]).size;
  return union === 0 ? 0 : intersect / union;
}

/**
 * True when candidate tokens are ≥ threshold similar to any of existingList.
 */
export function isDuplicate(candidateTokens, existingList, threshold = 0.8) {
  for (const existing of existingList) {
    if (jaccardSimilarity(candidateTokens, existing) >= threshold) return true;
  }
  return false;
}
