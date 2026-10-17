// Shared graph, PPR and post-verification parameters.
export const CONFIG = {
    // PPR parameters (Page et al. 1998; GraftNet 2018 uses same values)
    ALPHA: 0.15,            // restart probability
    EPSILON: 1e-5,          // L1 convergence threshold
    MAX_ITER: 50,           // hard iteration cap (typically converges in 15-25)

    // Edge weight channel coefficients
    // Candidate generation uses WHAT + R semantic only.
    // WHO/WHERE are reweight-only signals.
    GAMMA: {
        what: 0.40,         // interaction pair overlap
        rSem: 0.40,         // semantic similarity over edges.r aggregate
        who: 0.10,          // endpoint entity overlap   (reweight-only)
        where: 0.05,        // location exact match      (reweight-only)
        time: 0.05,         // temporal decay score
    },
    // R semantic candidate generation
    R_SEM_MIN_SIM: 0.62,
    R_SEM_TOPK: 8,
    TIME_WINDOW_MAX: 80,
    TIME_DECAY_DIVISOR: 12,
    WHERE_MAX_GROUP_SIZE: 16,   // skip location-only pair expansion for over-common places
    WHERE_FREQ_DAMP_PIVOT: 6,   // location freq <= pivot keeps full WHERE score
    WHERE_FREQ_DAMP_MIN: 0.20,  // lower bound for damped WHERE contribution

    // Post-verification (Cosine Gate)
    COSINE_GATE: 0.46,      // min cosine(queryVector, stateVector)
    SCORE_FLOOR: 0.10,      // min finalScore = PPR_normalized × cosine
    DIFFUSION_CAP: 100,     // max diffused nodes (excluding seeds)
};
