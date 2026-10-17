/**
 * 格式化权重数组为紧凑字符串
 * @param {number[]|null} weights
 * @returns {string}
 */
function fmtWeights(weights) {
    if (!weights?.length) return 'N/A';
    return '[' + weights.map(w => (typeof w === 'number' ? w.toFixed(3) : String(w))).join(', ') + ']';
}

/**
 * 格式化指标为可读日志
 * @param {object} metrics
 * @returns {string}
 */
export function formatMetricsLog(metrics, { complete = true } = {}) {
    const m = metrics;
    const lines = [];

    lines.push('');
    lines.push('════════════════════════════════════════');
    lines.push('          Recall Metrics Report         ');
    lines.push('════════════════════════════════════════');
    if (!complete) lines.push('本轮未完成注入；以下为已采集的部分指标，0 不代表该阶段成功执行。');
    lines.push('');

    if (m.external.failures.length) {
        lines.push('[External Requests] 请求失败与重试记录');
        for (const failure of m.external.failures) {
            const details = [failure.kind];
            if (failure.status != null) details.push(`HTTP ${failure.status}`);
            if (failure.attempt != null) details.push(`attempt=${failure.attempt}`);
            if (failure.batchIndex != null) details.push(`batch=${failure.batchIndex + 1}`);
            if (failure.elapsedMs != null) details.push(`${failure.elapsedMs}ms`);
            if (failure.message) details.push(failure.message);
            lines.push(`- ${failure.stage}: ${details.join(' | ')}`);
        }
        lines.push('');
    }

    // Query Length
    lines.push('[Query Length] 查询长度');
    lines.push(`├─ query_v0_chars: ${m.query?.lengths?.v0Chars ?? 0}`);
    lines.push(`├─ query_v1_chars: ${m.query?.lengths?.v1Chars == null ? 'N/A' : m.query.lengths.v1Chars}`);
    lines.push(`└─ rerank_query_chars: ${m.query?.lengths?.rerankChars ?? 0}`);
    lines.push('');

    // Query Build
    lines.push('[Query] 查询构建');
    lines.push(`├─ build_time: ${m.query.buildTime}ms`);
    lines.push(`├─ refine_time: ${m.query.refineTime}ms`);
    lines.push(`├─ r1_weights: ${fmtWeights(m.query.segmentWeights)}`);
    if (m.query.r2Weights) {
        lines.push(`└─ r2_weights: ${fmtWeights(m.query.r2Weights)}`);
    } else {
        lines.push(`└─ r2_weights: N/A (no hints)`);
    }
    lines.push('');

    // Anchor (L0 StateAtoms)
    lines.push('[Anchor] L0 StateAtoms - 语义锚点');
    lines.push(`├─ need_recall: ${m.anchor.needRecall}`);
    if (m.anchor.needRecall) {
        lines.push(`├─ focus_terms: [${(m.anchor.focusTerms || []).join(', ')}]`);
        lines.push(`├─ focus_characters: [${(m.anchor.focusCharacters || []).join(', ')}]`);
        lines.push(`├─ matched: ${m.anchor.matched || 0}`);
        lines.push(`└─ floors_hit: ${m.anchor.floorsHit || 0}`);
    }
    lines.push('');

    // Lexical (MiniSearch)
    lines.push('[Lexical] MiniSearch - 词法检索');
    lines.push(`├─ terms: [${(m.lexical.terms || []).slice(0, 8).join(', ')}]`);
    lines.push(`├─ atom_hits: ${m.lexical.atomHits}`);
    lines.push(`├─ chunk_hits: ${m.lexical.chunkHits}`);
    lines.push(`├─ event_hits: ${m.lexical.eventHits}`);
    lines.push(`├─ search_time: ${m.lexical.searchTime}ms`);
    if (m.lexical.indexReadyTime > 0) {
        lines.push(`├─ index_ready_time: ${m.lexical.indexReadyTime}ms`);
    }
    lines.push(`├─ idf_enabled: ${!!m.lexical.idfEnabled}`);
    if (m.lexical.idfDocCount > 0) {
        lines.push(`├─ idf_doc_count: ${m.lexical.idfDocCount}`);
    }
    if ((m.lexical.topIdfTerms || []).length > 0) {
        const topIdfText = m.lexical.topIdfTerms
            .slice(0, 5)
            .map(x => `${x.term}:${x.idf}`)
            .join(', ');
        lines.push(`├─ top_idf_terms: [${topIdfText}]`);
    }
    if (m.lexical.termSearches > 0) {
        lines.push(`├─ term_searches: ${m.lexical.termSearches}`);
    }
    if (m.lexical.eventFilteredByDense > 0) {
        lines.push(`├─ event_filtered_by_dense: ${m.lexical.eventFilteredByDense}`);
    }
    if (m.lexical.floorFilteredByDense > 0) {
        lines.push(`├─ floor_filtered_by_dense: ${m.lexical.floorFilteredByDense}`);
    }
    const gates = m.lexical.denseGateThresholds;
    lines.push(`└─ dense_gate_threshold: event=${gates?.event ?? 'N/A'}, floor=${gates?.floor ?? 'N/A'}`);
    lines.push('');

    // Fusion (W-RRF, floor-level)
    lines.push('[Fusion] W-RRF (floor-level) - 多路融合');
    lines.push(`├─ dense_floors: ${m.fusion.denseFloors}`);
    lines.push(`├─ lex_floors: ${m.fusion.lexFloors}`);
    if (m.fusion.lexDensityBonus > 0) {
        lines.push(`│   └─ density_bonus: ${m.fusion.lexDensityBonus}`);
    }
    lines.push(`├─ total_unique: ${m.fusion.totalUnique}`);
    lines.push(`├─ after_cap: ${m.fusion.afterCap}`);
    lines.push(`└─ time: ${m.fusion.time}ms`);
    lines.push('');

    // Fusion Guard (must-keep lexical floors)
    lines.push('[Fusion Guard] Lexical Must-Keep');
    lines.push(`├─ must_keep_terms: ${m.evidence.mustKeepTermsCount || 0}`);
    lines.push(`├─ must_keep_floors: ${m.evidence.mustKeepFloorsCount || 0}`);
    if ((m.evidence.mustKeepFloors || []).length > 0) {
        lines.push(`│   └─ floors: [${m.evidence.mustKeepFloors.slice(0, 10).join(', ')}]`);
    }
    if ((m.evidence.lexHitButNotSelected || 0) > 0) {
        lines.push(`└─ lex_hit_but_not_selected: ${m.evidence.lexHitButNotSelected}`);
    } else {
        lines.push(`└─ lex_hit_but_not_selected: 0`);
    }
    lines.push('');

    // Constraint (L3 Facts)
    lines.push('[Constraint] L3 Facts - 世界约束');
    lines.push(`├─ total: ${m.constraint.total}`);
    lines.push(`├─ filtered: ${m.constraint.filtered || 0}`);
    lines.push(`├─ injected: ${m.constraint.injected}`);
    lines.push(`├─ tokens: ${m.constraint.tokens}`);
    if (m.constraint.samples && m.constraint.samples.length > 0) {
        lines.push(`└─ samples: "${m.constraint.samples.slice(0, 2).join('", "')}"`);
    }
    lines.push('');

    // Event (L2 Events)
    lines.push('[Event] L2 Events - 事件摘要');
    lines.push(`├─ in_store: ${m.event.inStore}`);
    lines.push(`├─ considered: ${m.event.considered}`);
    if ((m.event.candidateVectorsMissing || 0) > 0) {
        lines.push(`├─ candidate_vectors_missing: ${m.event.candidateVectorsMissing}`);
    }

    if (m.event.entityFilter) {
        const ef = m.event.entityFilter;
        lines.push(`├─ entity_filter:`);
        lines.push(`│   ├─ focus_characters: [${(ef.focusCharacters || []).join(', ')}]`);
        lines.push(`│   ├─ before: ${ef.before}`);
        lines.push(`│   ├─ after: ${ef.after}`);
        lines.push(`│   └─ filtered: ${ef.filtered}`);
    }

    lines.push(`├─ selected: ${m.event.selected}`);
    lines.push(`├─ by_recall_type:`);
    lines.push(`│   ├─ direct: ${m.event.byRecallType.direct}`);
    lines.push(`│   ├─ related: ${m.event.byRecallType.related}`);
    lines.push(`│   ├─ causal: ${m.event.byRecallType.causal}`);
    if (m.event.byRecallType.l0Linked) {
        lines.push(`│   ├─ lexical: ${m.event.byRecallType.lexical}`);
        lines.push(`│   └─ l0_linked: ${m.event.byRecallType.l0Linked}`);
    } else {
        lines.push(`│   └─ lexical: ${m.event.byRecallType.lexical}`);
    }

    const sim = m.event.similarityDistribution;
    if (sim && sim.max > 0) {
        lines.push(`├─ similarity_distribution:`);
        lines.push(`│   ├─ min: ${sim.min}`);
        lines.push(`│   ├─ max: ${sim.max}`);
        lines.push(`│   ├─ mean: ${sim.mean}`);
        lines.push(`│   └─ median: ${sim.median}`);
    }

    if (m.event.rerank.status) {
        const rerank = m.event.rerank;
        const exactTime = rerank.exactTime;
        lines.push(`├─ event_rerank: ${rerank.status}`);
        lines.push(`│   ├─ candidates: ${rerank.candidates || 0}/${rerank.sourceCandidates || 0}`);
        lines.push(`│   ├─ tail: ${rerank.tailCandidates || 0}`);
        if (exactTime.marker) {
            lines.push(`│   ├─ exact_time: ${exactTime.marker}, floors=${exactTime.floors || 0}, candidates=${exactTime.candidates || 0}, winners=${exactTime.winners || 0}, reserved=${exactTime.reserved || 0}, forced=${exactTime.forced || 0}, overflow=${exactTime.overflow || 0}`);
        }
        lines.push(`│   └─ batches: ${rerank.batchTotal || 0}, failed=${rerank.batchFailed || 0}`);
    }

    lines.push(`├─ causal_chain: depth=${m.event.causalChainDepth}, count=${m.event.causalCount}`);
    if (m.event.byOwnership) {
        const bo = m.event.byOwnership;
        lines.push(`├─ by_ownership: focus=${bo.focus || 0}, other=${bo.other || 0}, unknown=${bo.unknown || 0}`);
    }
    if (m.event.budgetTruncated) {
        const bt = m.event.budgetTruncated;
        lines.push(`├─ budget_truncation: selected=${bt.selected}/${bt.candidates}, dropped=${bt.dropped}, event_budget=${bt.budgetRejected || 0}, related_budget=${bt.relatedBudgetRejected || 0}`);
    }
    if ((m.event.temporalFloorsProtected || 0) > 0) {
        lines.push(`├─ temporal_protection: floors=${m.event.temporalFloorsProtected}, winners=${m.event.temporalWinners || 0}, protected=${m.event.temporalProtected || 0}, overflow=${m.event.temporalOverflow || 0}, dropped=${m.event.temporalDropped || 0}, cap=${m.event.temporalProtectionCap || 0}`);
    }
    lines.push(`└─ focus_characters_used: ${m.event.entitiesUsed} [${(m.event.entityNames || []).join(', ')}], focus_terms_count=${m.event.focusTermsCount || 0}`);
    lines.push('');

    // Evidence (Two-Stage: Floor Rerank → L1 Pull)
    lines.push('[Evidence] Two-Stage: Floor Rerank → L1 Pull');
    lines.push(`├─ Stage 1 (Floor Rerank):`);
    lines.push(`│   ├─ floor_candidates (post-fusion): ${m.evidence.floorCandidates}`);

    if (m.evidence.rerankApplied) {
        lines.push(`│   ├─ rerank_applied: true`);
        if (m.evidence.rerankFailed) {
            lines.push(`│   │   ⚠ rerank_failed: using fusion order`);
        }
        lines.push(`│   │   ├─ before: ${m.evidence.beforeRerank} floors`);
        lines.push(`│   │   ├─ after: ${m.evidence.afterRerank} floors`);
        lines.push(`│   │   ├─ batches: ${m.evidence.rerankBatchTotal || 0}, failed=${m.evidence.rerankBatchFailed || 0}`);
        lines.push(`│   │   └─ time: ${m.timing.evidenceRerank || 0}ms`);
        if ((m.evidence.droppedByRerankCount || 0) > 0) {
            lines.push(`│   ├─ dropped_normal: ${m.evidence.droppedByRerankCount}`);
        }
        if (m.evidence.rerankScores) {
            const rs = m.evidence.rerankScores;
            lines.push(`│   ├─ rerank_scores: min=${rs.min}, max=${rs.max}, mean=${rs.mean}`);
        }
        if (m.evidence.rerankDocAvgLength > 0) {
            lines.push(`│   ├─ rerank_doc_avg_length: ${m.evidence.rerankDocAvgLength} chars`);
        }
    } else {
        lines.push(`│   ├─ rerank_applied: false`);
    }

    lines.push(`│   ├─ floors_selected: ${m.evidence.floorsSelected}`);
    lines.push(`│   └─ l0_atoms_collected: ${m.evidence.l0Collected}`);
    lines.push(`├─ Stage 2 (L1):`);
    lines.push(`│   ├─ prefetched_ai_floors: ${m.evidence.l1PrefetchAiFloors}`);
    lines.push(`│   ├─ prefetched_total_floors: ${m.evidence.l1PrefetchWithContextFloors}`);
    lines.push(`│   ├─ pulled: ${m.evidence.l1Pulled}`);
    lines.push(`│   ├─ vector_hits: ${m.evidence.l1VectorHits}`);
    if ((m.evidence.l1MissingVectors || 0) > 0) {
        lines.push(`│   ├─ missing_vectors: ${m.evidence.l1MissingVectors}`);
    }
    lines.push(`│   ├─ attached: ${m.evidence.l1Attached}`);
    lines.push(`│   ├─ cosine_time: ${m.evidence.l1CosineTime}ms`);
    lines.push(`│   ├─ cache: warm=${!!m.evidence.l1CacheWarm}, chunk=${m.evidence.l1ChunkCacheHits || 0}/${m.evidence.l1ChunkCacheMisses || 0}, vector=${m.evidence.l1VectorCacheHits || 0}/${m.evidence.l1VectorCacheMisses || 0}`);
    lines.push(`│   ├─ fallback_db_time: ${m.evidence.l1CacheFallbackDbTime || 0}ms`);
    lines.push(`│   └─ breakdown: chunk_db=${m.evidence.l1ChunkFetchTime}ms, vector_db=${m.evidence.l1VectorFetchTime}ms, deserialize=${m.evidence.l1DeserializeTime}ms, score=${m.evidence.l1ScoreTime}ms, sort=${m.evidence.l1SortTime}ms`);
    if (m.evidence.directEvidenceStatus) {
        lines.push(`├─ Event evidence: ${m.evidence.directEvidenceStatus}`);
        lines.push(`│   ├─ parents/floors: ${m.evidence.directEvidenceParents || 0}/${m.evidence.directEvidenceFloors || 0}`);
        lines.push(`│   ├─ candidates: ${m.evidence.directEvidenceSourceCandidates || 0} → ${m.evidence.directEvidenceCandidates || 0} → relevant=${m.evidence.directEvidenceRelevantItems || 0}`);
        lines.push(`│   ├─ enumerated/admitted: ${m.evidence.directEvidenceEnumerated || 0}/${m.evidence.directEvidenceAdmitted || 0}, skipped_by_budget=${m.evidence.directEvidenceSkippedByBudget || 0}`);
        if ((m.evidence.directEvidenceTemporalProtectedItems || 0) > 0) {
            lines.push(`│   ├─ temporal_protected_in_prompt: items=${m.evidence.directEvidenceTemporalProtectedItems}, tokens=${m.evidence.directEvidenceTemporalProtectedTokens || 0}`);
        }
        lines.push(`│   ├─ local_selection: event=${m.evidence.directEvidenceEventItems || 0}, conversation=${m.evidence.directEvidenceConversationItems || 0}, lexical_hits=${m.evidence.directEvidenceLexicalItems || 0}`);
        lines.push(`│   ├─ vector_coverage: hits=${m.evidence.directEvidenceVectorHits || 0}, missing=${m.evidence.directEvidenceMissingVectors || 0}`);
        lines.push(`│   ├─ temporal_candidate_protection: candidates=${m.evidence.directEvidenceTemporalCandidates || 0}, floor_winners=${m.evidence.directEvidenceTemporalFloorWinners || 0}, protected=${m.evidence.directEvidenceTemporalProtectedCandidates || 0}`);
        lines.push(`│   ├─ selected_L1/prompt_L0_L1: ${m.evidence.directEvidenceItems || 0}/${m.evidence.directEvidencePromptItems || 0} in ${m.evidence.directEvidencePromptGroups || 0} groups`);
        lines.push(`│   ├─ missing_event_vectors: ${m.evidence.directEvidenceMissingEventVectors || 0}, L0_protected_tokens=${m.evidence.l0ProtectedTokens || 0}`);
        lines.push(`│   └─ prompt_tokens: ${m.evidence.directEvidencePromptTokens || 0}`);
    }
    if (m.evidence.causalEvidence) {
        const causal = m.evidence.causalEvidence;
        lines.push(`├─ causal_evidence: links=${causal.links}/${causal.candidates}, bodies=${causal.bodies}, tokens=${causal.tokens}/${causal.maxTokens}, per_event_max=${causal.perEventMaxTokens}`);
    }
    if (m.evidence.eventEvidenceBudgetMax > 0) {
        lines.push(`├─ event_evidence_budget: ${m.evidence.eventEvidenceBudgetUsed}/${m.evidence.eventEvidenceBudgetMax}`);
    }
    if (m.evidence.distantEvidenceBudgetMax > 0) {
        lines.push(`├─ distant_evidence_budget: ${m.evidence.distantEvidenceBudgetUsed}/${m.evidence.distantEvidenceBudgetMax}, groups_dropped=${m.evidence.distantEvidenceDroppedByBudget}`);
    }
    lines.push(`├─ tokens: ${m.evidence.tokens}`);
    lines.push(`└─ assembly_time: ${m.timing.evidenceAssembly || 0}ms`);
    lines.push('');

    // Diffusion (PPR)
    lines.push('[Diffusion] PPR Spreading Activation');
    lines.push(`├─ seeds: ${m.diffusion.seedCount}`);
    lines.push(`├─ graph: ${m.diffusion.graphNodes} nodes, ${m.diffusion.graphEdges} edges`);
    lines.push(`├─ candidate_pairs: ${m.diffusion.candidatePairs || 0} (what=${m.diffusion.pairsFromWhat || 0}, r_sem=${m.diffusion.pairsFromRSem || 0})`);
    lines.push(`├─ r_sem_avg_sim: ${m.diffusion.rSemAvgSim || 0}`);
    lines.push(`├─ pair_filters: what_window_skipped_occurrences=${m.diffusion.whatWindowSkippedOccurrences || 0}, topk_pruned=${m.diffusion.topKPrunedPairs || 0}`);
    lines.push(`├─ edge_density: ${m.diffusion.edgeDensity || 0}%`);
    if (m.diffusion.graphEdges > 0) {
        const ch = m.diffusion.byChannel || {};
        lines.push(`│   ├─ by_channel: what=${ch.what || 0}, r_sem=${ch.rSem || 0}, who=${ch.who || 0}, where=${ch.where || 0}`);
        lines.push(`│   └─ reweight_used: who=${m.diffusion.reweightWhoUsed || 0}, where=${m.diffusion.reweightWhereUsed || 0}`);
    }
    if (m.diffusion.iterations > 0) {
        lines.push(`├─ ppr: ${m.diffusion.iterations} iterations, ε=${Number(m.diffusion.convergenceError).toExponential(1)}`);
    }
    lines.push(`├─ activated (excl seeds): ${m.diffusion.pprActivated}`);
    if (m.diffusion.pprActivated > 0) {
        lines.push(`├─ cosine_gate: ${m.diffusion.cosineGatePassed} passed, ${m.diffusion.cosineGateFiltered} filtered`);
        const passPrefix = m.diffusion.cosineGateNoVector > 0 ? '│   ├─' : '│   └─';
        lines.push(`${passPrefix} pass_rate: ${m.diffusion.postGatePassRate || 0}%`);
        if (m.diffusion.cosineGateNoVector > 0) {
            lines.push(`│   ├─ no_vector: ${m.diffusion.cosineGateNoVector}`);
        }
    }
    lines.push(`├─ final_injected: ${m.diffusion.finalCount}`);
    if (m.diffusion.finalCount > 0) {
        const ds = m.diffusion.scoreDistribution;
        lines.push(`├─ scores: min=${ds.min}, max=${ds.max}, mean=${ds.mean}`);
    }
    lines.push(`├─ breakdown: index=${m.diffusion.indexTime || 0}ms, graph=${m.diffusion.buildTime || 0}ms, seed=${m.diffusion.seedVectorTime || 0}ms, normalize=${m.diffusion.normalizeTime || 0}ms, ppr=${m.diffusion.pprTime || 0}ms, vector_map=${m.diffusion.vectorMapTime || 0}ms, post=${m.diffusion.postVerifyTime || 0}ms`);
    lines.push(`└─ time: ${m.diffusion.time}ms`);
    lines.push('');

    // Formatting
    lines.push('[Formatting] 格式化');
    lines.push(`├─ sections: [${(m.formatting.sectionsIncluded || []).join(', ')}]`);
    lines.push(`└─ time: ${m.timing.formatting || 0}ms`);
    lines.push('');

    // Budget Summary
    lines.push('[Budget] 预算');
    lines.push(`├─ total_tokens: ${m.budget.total}`);
    lines.push(`├─ limit: ${m.budget.limit}`);
    lines.push(`├─ utilization: ${m.budget.utilization}%`);
    lines.push(`└─ breakdown:`);
    const bd = m.budget.breakdown || {};
    lines.push(`    ├─ constraints: ${bd.constraints || 0}`);
    lines.push(`    ├─ events: ${bd.events || 0}`);
    lines.push(`    ├─ direct_evidence: ${bd.directEvidence || 0}`);
    lines.push(`    ├─ causal_evidence: ${bd.causalEvidence || 0}`);
    lines.push(`    ├─ distant_evidence: ${bd.distantEvidence || 0}`);
    lines.push(`    ├─ recent_evidence: ${bd.recentEvidence || 0}`);
    lines.push(`    └─ arcs: ${bd.arcs || 0}`);
    lines.push('');

    // Timing
    lines.push('[Timing] 计时');
    lines.push(`├─ query_build: ${m.query.buildTime}ms`);
    lines.push(`├─ query_refine: ${m.query.refineTime}ms`);
    lines.push(`├─ round1_embed: ${m.timing.round1Embed || 0}ms`);
    if ((m.timing.round1EmbedRetryWait || 0) > 0) {
        lines.push(`│   └─ retry_wait: ${m.timing.round1EmbedRetryWait}ms`);
    }
    lines.push(`├─ round1_anchor_search: ${m.timing.round1AnchorSearch || 0}ms`);
    lines.push(`├─ round1_event_retrieval: ${m.timing.round1EventRetrieval || 0}ms`);
    lines.push(`├─ round2_embed: ${m.timing.round2Embed || 0}ms`);
    lines.push(`├─ runtime_begin_session: ${m.timing.runtimeBeginSession || 0}ms`);
    lines.push(`│   ├─ runtime_load_db: ${m.timing.runtimeLoadFromDB || 0}ms`);
    lines.push(`│   └─ runtime_build_entry: ${m.timing.runtimeBuildEntry || 0}ms`);
    lines.push(`├─ anchor_search: ${m.timing.anchorSearch}ms`);
    lines.push(`│   └─ runtime_score_anchors: ${m.timing.runtimeScoreAnchors || 0}ms`);
    const lexicalTotal = (m.lexical.searchTime || 0) + (m.lexical.indexReadyTime || 0);
    lines.push(`├─ lexical_search: ${lexicalTotal}ms (query=${m.lexical.searchTime || 0}ms, index_ready=${m.lexical.indexReadyTime || 0}ms)`);
    lines.push(`├─ fusion: ${m.fusion.time}ms`);
    lines.push(`├─ constraint_filter: ${m.timing.constraintFilter}ms`);
    lines.push(`├─ event_retrieval: ${m.timing.eventRetrieval}ms`);
    lines.push(`│   ├─ runtime_score_events: ${m.timing.runtimeScoreEvents || 0}ms`);
    lines.push(`│   └─ runtime_get_event_vectors: ${m.timing.runtimeGetEventVectors || 0}ms`);
    lines.push(`├─ evidence_retrieval: ${m.timing.evidenceRetrieval}ms`);
    lines.push(`├─ floor_rerank: ${m.timing.evidenceRerank || 0}ms`);
    if (m.event.rerank.status) {
        lines.push(`├─ event_rerank: ${m.timing.eventRerank || 0}ms`);
    }
    if (m.evidence.directEvidenceStatus) {
        lines.push(`├─ direct_evidence_retrieval: ${m.timing.directEvidenceRetrieval || 0}ms`);
    }
    lines.push(`├─ l1_cosine: ${m.evidence.l1CosineTime}ms`);
    lines.push(`│   ├─ l1_chunk_db: ${m.evidence.l1ChunkFetchTime}ms`);
    lines.push(`│   ├─ l1_vector_db: ${m.evidence.l1VectorFetchTime}ms`);
    lines.push(`│   ├─ l1_cache: warm=${!!m.evidence.l1CacheWarm}, chunk=${m.evidence.l1ChunkCacheHits || 0}/${m.evidence.l1ChunkCacheMisses || 0}, vector=${m.evidence.l1VectorCacheHits || 0}/${m.evidence.l1VectorCacheMisses || 0}`);
    lines.push(`│   ├─ l1_cache_fallback_db: ${m.evidence.l1CacheFallbackDbTime || 0}ms`);
    lines.push(`│   ├─ l1_deserialize: ${m.evidence.l1DeserializeTime}ms`);
    lines.push(`│   ├─ l1_score: ${m.evidence.l1ScoreTime}ms`);
    lines.push(`│   ├─ l1_sort: ${m.evidence.l1SortTime}ms`);
    lines.push(`│   └─ runtime_score_l1: ${m.timing.runtimeScoreL1 || 0}ms`);
    lines.push(`├─ diffusion: ${m.timing.diffusion}ms`);
    lines.push(`│   ├─ graph_build: ${m.diffusion.buildTime || 0}ms`);
    lines.push(`│   ├─ ppr: ${m.diffusion.pprTime || 0}ms`);
    lines.push(`│   ├─ post_verify: ${m.diffusion.postVerifyTime || 0}ms`);
    lines.push(`│   ├─ vector_map: ${m.diffusion.vectorMapTime || 0}ms`);
    lines.push(`│   └─ runtime_diffuse_l0: ${m.timing.runtimeDiffuseL0 || 0}ms`);
    lines.push(`├─ evidence_assembly: ${m.timing.evidenceAssembly}ms`);
    lines.push(`├─ formatting: ${m.timing.formatting}ms`);
    lines.push(`├─ external_total: ${m.timing.externalTotal || 0}ms (embed+rerank, excludes retry wait)`);
    lines.push(`├─ local_known_total: ${m.timing.localKnownTotal || 0}ms`);
    lines.push(`├─ unattributed: ${m.timing.unattributed || 0}ms`);
    lines.push(`├─ runtime_end_session: ${m.timing.runtimeEndSession || 0}ms`);
    lines.push(`└─ total: ${m.timing.total}ms`);
    lines.push('');

    // Quality Indicators
    lines.push('[Quality] 质量指标');
    if (!complete) {
        lines.push('└─ not evaluated: recall did not complete with an injected result');
        return lines.join('\n');
    }
    lines.push(`├─ constraint_coverage: ${m.quality.constraintCoverage}%`);
    lines.push(`├─ l1_attach_rate: ${m.quality.l1AttachRate}%`);
    lines.push(`├─ rerank_retention_rate: ${m.quality.rerankRetentionRate}%`);
    lines.push(`├─ diffusion_effective_rate: ${m.quality.diffusionEffectiveRate}%`);

    if (m.quality.potentialIssues && m.quality.potentialIssues.length > 0) {
        lines.push(`└─ potential_issues:`);
        m.quality.potentialIssues.forEach((issue, i) => {
            const prefix = i === m.quality.potentialIssues.length - 1 ? '   └─' : '   ├─';
            lines.push(`${prefix} ⚠ ${issue}`);
        });
    } else {
        lines.push(`└─ potential_issues: none`);
    }

    lines.push('');
    lines.push('════════════════════════════════════════');
    lines.push('');

    return lines.join('\n');
}

