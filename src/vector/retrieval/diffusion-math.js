// Unicode-safe text normalization (matches recall.js / entity-lexicon.js).
export function normalize(s) {
    return String(s || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim()
        .toLowerCase();
}

// Cosine similarity between two vectors.
export function cosineSimilarity(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0, nA = 0, nB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        nA += a[i] * a[i];
        nB += b[i] * b[i];
    }
    return nA && nB ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
}
