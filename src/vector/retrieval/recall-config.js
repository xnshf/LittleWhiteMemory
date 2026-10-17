// Recall thresholds and limits shared by the coordinator and floor evidence stage.
export const CONFIG = {
    // 固定读取 chat 末尾 3 条；普通发送时末条是真实入列的当前 USER 消息。
    LAST_MESSAGES_K: 3,

    // Anchor (L0 StateAtoms)
    ANCHOR_MIN_SIMILARITY: 0.58,

    // Event (L2 Events)
    EVENT_CANDIDATE_MAX: 100,
    EVENT_SELECT_MAX: 50,
    EVENT_MIN_SIMILARITY: 0.60,
    EVENT_MMR_LAMBDA: 0.72,
    EVENT_ENTITY_BYPASS_SIM: 0.70,
    EVENT_EVIDENCE_MIN_SIMILARITY: 0.70,

    // Lexical Dense 门槛
    LEXICAL_EVENT_DENSE_MIN: 0.60,
    LEXICAL_FLOOR_DENSE_MIN: 0.50,

    // W-RRF 融合（L0-only）
    RRF_K: 60,
    RRF_W_DENSE: 1.0,
    RRF_W_LEX: 0.9,
    FUSION_CAP: 60,

    // Lexical floor 聚合密度加成
    LEX_DENSITY_BONUS: 0.3,

    // Rerank（floor-level）
    RERANK_TOP_N: 20,
    RERANK_MIN_SCORE: 0.10,

    // Fusion guard: lexical must-keep floors
    MUST_KEEP_MAX_FLOORS: 3,
    MUST_KEEP_MIN_IDF: 2.2,
    MUST_KEEP_CLUSTER_WINDOW: 2,

    // 因果链
    CAUSAL_CHAIN_MAX_DEPTH: 10,
    CAUSAL_INJECT_MAX: 30,
};
