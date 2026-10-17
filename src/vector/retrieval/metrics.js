// Story Summary per-run recall diagnostics.
// Every collected field must have a runtime log, issue detector, or replay/gold consumer.

/**
 * 创建空的指标对象
 * @returns {object}
 */
export function createMetrics() {
    return {
        external: {
            failures: [],
        },

        // Query Build - 查询构建
        query: {
            buildTime: 0,
            refineTime: 0,
            lengths: {
                v0Chars: 0,
                v1Chars: null,     // null = 无 hints
                rerankChars: 0,
            },
            segmentWeights: [],    // R1 归一化后权重 [context..., focus]
            r2Weights: null,       // R2 归一化后权重 [context..., focus, hints]（null = 无 hints）
        },

        // Anchor (L0 StateAtoms) - 语义锚点
        anchor: {
            needRecall: false,
            focusTerms: [],
            focusCharacters: [],
            matched: 0,
            floorsHit: 0,
        },

        // Lexical (MiniSearch) - 词法检索
        lexical: {
            terms: [],
            atomHits: 0,
            chunkHits: 0,
            eventHits: 0,
            searchTime: 0,
            indexReadyTime: 0,
            idfEnabled: false,
            idfDocCount: 0,
            topIdfTerms: [],
            termSearches: 0,
            eventFilteredByDense: 0,
            floorFilteredByDense: 0,
            denseGateThresholds: null,
        },

        // Fusion (W-RRF, floor-level) - 多路融合
        fusion: {
            denseFloors: 0,
            lexFloors: 0,
            totalUnique: 0,
            afterCap: 0,
            time: 0,
            lexDensityBonus: 0,    // 密度加成系数
        },

        // Constraint (L3 Facts) - 世界约束
        constraint: {
            total: 0,
            filtered: 0,
            injected: 0,
            tokens: 0,
            samples: [],
        },

        // Event (L2 Events) - 事件摘要
        event: {
            inStore: 0,
            considered: 0,
            selected: 0,
            byRecallType: { direct: 0, related: 0, causal: 0, lexical: 0, l0Linked: 0 },
            byOwnership: null,
            similarityDistribution: { min: 0, max: 0, mean: 0, median: 0 },
            entityFilter: null,
            causalChainDepth: 0,
            causalCount: 0,
            entitiesUsed: 0,
            focusTermsCount: 0,
            entityNames: [],
            temporalFloorsProtected: 0,
            temporalProtected: 0,
            temporalDropped: 0,
            temporalWinners: 0,
            temporalProtectionCap: 0,
            temporalOverflow: 0,
            candidateVectorsMissing: 0,
            rerank: {
                status: '',
                sourceCandidates: 0,
                candidates: 0,
                tailCandidates: 0,
                exactTime: {
                    marker: '',
                    floors: 0,
                    candidates: 0,
                    winners: 0,
                    reserved: 0,
                    overflow: 0,
                    forced: 0,
                },
                batchTotal: 0,
                batchFailed: 0,
            },
            budgetTruncated: null,
        },

        // Evidence (Two-Stage: Floor rerank → L1 pull) - 原文证据
        evidence: {
            // Stage 1: Floor
            floorCandidates: 0,
            floorsSelected: 0,
            l0Collected: 0,
            mustKeepTermsCount: 0,
            mustKeepFloorsCount: 0,
            mustKeepFloors: [],
            droppedByRerankCount: 0,
            lexHitButNotSelected: 0,
            rerankApplied: false,
            rerankFailed: false,
            rerankBatchTotal: 0,
            rerankBatchFailed: 0,
            beforeRerank: 0,
            afterRerank: 0,
            rerankScores: null,
            rerankDocAvgLength: 0,

            // Stage 2: L1
            l1PrefetchAiFloors: 0,
            l1PrefetchWithContextFloors: 0,
            l1Pulled: 0,
            l1Attached: 0,
            l1CosineTime: 0,
            l1ChunkFetchTime: 0,
            l1VectorFetchTime: 0,
            l1DeserializeTime: 0,
            l1ScoreTime: 0,
            l1SortTime: 0,
            l1VectorHits: 0,
            l1MissingVectors: 0,
            l1ChunkCacheHits: 0,
            l1ChunkCacheMisses: 0,
            l1VectorCacheHits: 0,
            l1VectorCacheMisses: 0,
            l1CacheWarm: false,
            l1CacheFallbackDbTime: 0,

            // Selected events → local two-lane L1 evidence selection
            directEvidenceStatus: '',
            directEvidenceParents: 0,
            directEvidenceFloors: 0,
            directEvidenceSourceCandidates: 0,
            directEvidenceCandidates: 0,
            directEvidenceRelevantItems: 0,
            directEvidenceTemporalCandidates: 0,
            directEvidenceTemporalFloorWinners: 0,
            directEvidenceTemporalProtectedCandidates: 0,
            directEvidenceVectorHits: 0,
            directEvidenceMissingVectors: 0,
            directEvidenceMissingEventVectors: 0,
            directEvidenceEventItems: 0,
            directEvidenceConversationItems: 0,
            directEvidenceLexicalItems: 0,
            l0ProtectedTokens: 0,
            directEvidenceItems: 0,
            directEvidencePromptGroups: 0,
            directEvidencePromptItems: 0,
            directEvidencePromptTokens: 0,
            directEvidenceEnumerated: 0,
            directEvidenceAdmitted: 0,
            directEvidenceSkippedByBudget: 0,
            directEvidenceTemporalProtectedItems: 0,
            directEvidenceTemporalProtectedTokens: 0,
            directEvidenceTemporalProtectionBudgetMax: 0,
            eventEvidenceBudgetUsed: 0,
            eventEvidenceBudgetMax: 0,
            causalEvidence: null,
            distantEvidenceBudgetUsed: 0,
            distantEvidenceBudgetMax: 0,
            distantEvidenceDroppedByBudget: 0,

            // 装配
            contextPairsAdded: 0,
            tokens: 0,
        },

        // Diffusion (PPR Spreading Activation) - 图扩散
        diffusion: {
            seedCount: 0,
            graphNodes: 0,
            graphEdges: 0,
            candidatePairs: 0,
            pairsFromWhat: 0,
            pairsFromRSem: 0,
            rSemAvgSim: 0,
            whatWindowSkippedOccurrences: 0,
            topKPrunedPairs: 0,
            edgeDensity: 0,
            reweightWhoUsed: 0,
            reweightWhereUsed: 0,
            iterations: 0,
            convergenceError: 0,
            pprActivated: 0,
            cosineGatePassed: 0,
            cosineGateFiltered: 0,
            cosineGateNoVector: 0,
            postGatePassRate: 0,
            finalCount: 0,
            scoreDistribution: { min: 0, max: 0, mean: 0 },
            byChannel: { what: 0, where: 0, rSem: 0, who: 0 },
            indexTime: 0,
            buildTime: 0,
            seedVectorTime: 0,
            normalizeTime: 0,
            pprTime: 0,
            vectorMapTime: 0,
            postVerifyTime: 0,
            time: 0,
        },

        // Formatting - 格式化
        formatting: {
            sectionsIncluded: [],
        },

        // Budget Summary - 预算
        budget: {
            total: 0,
            limit: 0,
            utilization: 0,
            breakdown: {
                constraints: 0,
                events: 0,
                directEvidence: 0,
                causalEvidence: 0,
                distantEvidence: 0,
                recentEvidence: 0,
                arcs: 0,
            },
        },

        // Timing - 计时（仅包含实际写入的字段）
        timing: {
            runtimeBeginSession: 0,
            runtimeLoadFromDB: 0,
            runtimeBuildEntry: 0,
            runtimeScoreAnchors: 0,
            runtimeScoreEvents: 0,
            runtimeGetEventVectors: 0,
            runtimeScoreL1: 0,
            runtimeDiffuseL0: 0,
            runtimeEndSession: 0,
            round1Embed: 0,
            round1EmbedRetryWait: 0,
            round1AnchorSearch: 0,
            round1EventRetrieval: 0,
            round2Embed: 0,
            anchorSearch: 0,
            constraintFilter: 0,
            eventRetrieval: 0,
            eventRerank: 0,
            evidenceRetrieval: 0,
            evidenceRerank: 0,
            directEvidenceRetrieval: 0,
            evidenceAssembly: 0,
            diffusion: 0,
            formatting: 0,
            externalTotal: 0,
            localKnownTotal: 0,
            unattributed: 0,
            total: 0,
        },

        // Quality Indicators - 质量指标
        quality: {
            constraintCoverage: 100,
            l1AttachRate: 0,
            rerankRetentionRate: 0,
            diffusionEffectiveRate: 0,
            potentialIssues: [],
        },
    };
}

// Parent spans exclude their separately measured children. Retry backoff is not API time.
export function finalizeMetricsTiming(metrics, totalMs) {
    const t = metrics.timing;
    // L1 selection is entirely local (including Worker scheduling/waiting),
    // with no child API request to attribute even if it fails or is cancelled.
    const directEvidenceLocal = Math.max(0, t.directEvidenceRetrieval);
    t.total = Math.round(totalMs);
    t.externalTotal = Math.round(
        Math.max(0, t.round1Embed - t.round1EmbedRetryWait)
        + t.round2Embed + t.evidenceRerank + t.eventRerank,
    );
    t.localKnownTotal = Math.round(
        metrics.query.buildTime + metrics.query.refineTime
        + t.runtimeBeginSession + t.runtimeEndSession
        + t.round1AnchorSearch + t.round1EventRetrieval + t.anchorSearch + t.eventRetrieval
        + metrics.lexical.searchTime + metrics.lexical.indexReadyTime + metrics.fusion.time
        + t.constraintFilter + t.evidenceRetrieval + t.diffusion + t.evidenceAssembly + t.formatting
        + directEvidenceLocal,
    );
    t.unattributed = Math.max(0, Math.round(t.total - t.externalTotal - t.localKnownTotal - t.round1EmbedRetryWait));
}

/**
 * 计算相似度分布统计
 * @param {number[]} similarities
 * @returns {{min: number, max: number, mean: number, median: number}}
 */
export function calcSimilarityStats(similarities) {
    if (!similarities?.length) {
        return { min: 0, max: 0, mean: 0, median: 0 };
    }

    const sorted = [...similarities].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
        min: Number(sorted[0].toFixed(3)),
        max: Number(sorted[sorted.length - 1].toFixed(3)),
        mean: Number((sum / sorted.length).toFixed(3)),
        median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    };
}

export { formatMetricsLog } from './metrics-format.js';

/**
 * 检测潜在问题
 * @param {object} metrics
 * @returns {string[]}
 */
export function detectIssues(metrics) {
    const issues = [];
    const m = metrics;

    // ─────────────────────────────────────────────────────────────────
    // 查询构建问题
    // ─────────────────────────────────────────────────────────────────

    if ((m.anchor.focusTerms || []).length === 0) {
        issues.push('No focus terms extracted');
    }

    // 权重极端退化检测
    const segWeights = m.query.segmentWeights || [];
    if (segWeights.length > 0) {
        const focusWeight = segWeights[segWeights.length - 1] || 0;
        if (focusWeight < 0.15) {
            issues.push(`Focus segment weight very low (${(focusWeight * 100).toFixed(0)}%) - focus message may be too short`);
        }
        const allLow = segWeights.every(w => w < 0.1);
        if (allLow) {
            issues.push('All segment weights below 10% - all messages may be extremely short');
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // 锚点匹配问题
    // ─────────────────────────────────────────────────────────────────

    if ((m.anchor.matched || 0) === 0 && m.anchor.needRecall) {
        issues.push('No anchors matched - may need to generate anchors');
    }

    // ─────────────────────────────────────────────────────────────────
    // 词法检索问题
    // ─────────────────────────────────────────────────────────────────

    if ((m.lexical.terms || []).length > 0 && m.lexical.chunkHits === 0 && m.lexical.eventHits === 0) {
        issues.push('Lexical search returned zero hits - terms may not match any indexed content');
    }

    // ─────────────────────────────────────────────────────────────────
    // 融合问题（floor-level）
    // ─────────────────────────────────────────────────────────────────

    if (m.fusion.lexFloors === 0 && m.fusion.denseFloors > 0) {
        issues.push('No lexical floors in fusion - hybrid retrieval not contributing');
    }

    if (m.fusion.afterCap === 0 && m.event.selected === 0) {
        issues.push('No floor or event candidates selected');
    }

    // ─────────────────────────────────────────────────────────────────
    // 事件召回问题
    // ─────────────────────────────────────────────────────────────────

    if (m.event.considered > 0) {
        const denseSelected =
            (m.event.byRecallType?.direct || 0) +
            (m.event.byRecallType?.related || 0);

        const denseSelectRatio = denseSelected / m.event.considered;

        if (denseSelectRatio < 0.1) {
            issues.push(`Dense event selection ratio too low (${(denseSelectRatio * 100).toFixed(1)}%) - threshold may be too high`);
        }
        if (denseSelectRatio > 0.6 && m.event.considered > 10) {
            issues.push(`Dense event selection ratio high (${(denseSelectRatio * 100).toFixed(1)}%) - may include noise`);
        }
    }

    // 实体过滤问题
    if (m.event.entityFilter) {
        const ef = m.event.entityFilter;
        if (ef.filtered === 0 && ef.before > 10) {
            issues.push('No events filtered by entity - focus entities may be too broad or missing');
        }
        if (ef.before > 0 && ef.filtered > ef.before * 0.8) {
            issues.push(`Too many events filtered (${ef.filtered}/${ef.before}) - focus may be too narrow`);
        }
    }

    // 相似度问题
    if (m.event.similarityDistribution && m.event.similarityDistribution.min > 0 && m.event.similarityDistribution.min < 0.5) {
        issues.push(`Low similarity events included (min=${m.event.similarityDistribution.min})`);
    }

    // ─────────────────────────────────────────────────────────────────
    // Floor Rerank 问题
    // ─────────────────────────────────────────────────────────────────

    if (m.evidence.rerankFailed) {
        issues.push('Rerank API failed — using fusion rank order as fallback, relevance scores are zero');
    }

    if (m.evidence.rerankApplied && !m.evidence.rerankFailed) {
        if (m.evidence.rerankScores) {
            const rs = m.evidence.rerankScores;
            if (rs.max < 0.3) {
                issues.push(`Low floor rerank scores (max=${rs.max}) - query-document domain mismatch`);
            }
            if (rs.mean < 0.2) {
                issues.push(`Very low average floor rerank score (mean=${rs.mean}) - context may be weak`);
            }
        }

        if ((m.timing.evidenceRerank || 0) > 3000) {
            issues.push(`Slow floor rerank (${m.timing.evidenceRerank}ms) - may affect response time`);
        }

        if (m.evidence.rerankDocAvgLength > 3000) {
            issues.push(`Large rerank documents (avg ${m.evidence.rerankDocAvgLength} chars) - may reduce rerank precision`);
        }
    }

    // Rerank 保留率
    const retentionRate = m.evidence.floorCandidates > 0
        ? Math.round(m.evidence.floorsSelected / m.evidence.floorCandidates * 100)
        : 0;
    m.quality.rerankRetentionRate = retentionRate;

    if (m.evidence.floorCandidates > 0 && retentionRate < 25) {
        issues.push(`Low rerank retention rate (${retentionRate}%) - fusion ranking poorly aligned with reranker`);
    }

    // ─────────────────────────────────────────────────────────────────
    // L1 挂载问题
    // ─────────────────────────────────────────────────────────────────

    if (m.evidence.floorsSelected > 0 && m.evidence.l1Pulled === 0) {
        issues.push('Zero L1 chunks pulled - L1 vectors may not exist or DB read failed');
    }

    if (m.evidence.floorsSelected > 0 && m.evidence.l1Attached === 0 && m.evidence.l1Pulled > 0) {
        issues.push('L1 chunks pulled but none attached - cosine scores may be too low');
    }

    const l1AttachRate = m.quality.l1AttachRate || 0;
    if (m.evidence.floorsSelected > 3 && l1AttachRate < 50) {
        issues.push(`Low L1 attach rate (${l1AttachRate}%) - selected floors lack L1 chunks`);
    }

    // ─────────────────────────────────────────────────────────────────
    // 预算问题
    // ─────────────────────────────────────────────────────────────────

    if (m.budget.utilization > 90) {
        issues.push(`High budget utilization (${m.budget.utilization}%) - may be truncating content`);
    }

    if (m.evidence.distantEvidenceDroppedByBudget > 0 && m.evidence.distantEvidenceBudgetUsed === 0) {
        issues.push('No complete distant evidence group fits its independent budget');
    }

    if ((m.event.temporalDropped || 0) > 0) {
        issues.push(`${m.event.temporalDropped} temporal event(s) still dropped - single event may exceed the event budget`);
    }

    if ((m.evidence.directEvidenceSkippedByBudget || 0) > 0
        && (m.evidence.directEvidenceEnumerated || 0) > 0
        && (m.evidence.directEvidenceAdmitted || 0) / m.evidence.directEvidenceEnumerated < 0.5) {
        issues.push(`Most DIRECT evidence skipped by budget (${m.evidence.directEvidenceSkippedByBudget}/${m.evidence.directEvidenceEnumerated}) - candidate face may be too wide`);
    }

    if ((m.event.budgetTruncated?.dropped || 0) > 0 && m.budget.utilization > 90) {
        issues.push(`Event packing truncated ${m.event.budgetTruncated.dropped} candidate(s) at budget limit`);
    }

    // ─────────────────────────────────────────────────────────────────
    // 性能问题
    // ─────────────────────────────────────────────────────────────────

    if (m.timing.total > 8000) {
        issues.push(`Slow recall (${m.timing.total}ms) - consider optimization`);
    }

    if ((m.timing.localKnownTotal || 0) > 1000) {
        issues.push(`Local recall work spike (${m.timing.localKnownTotal}ms) - inspect lexical/L1/diffusion breakdown`);
    }

    if ((m.timing.externalTotal || 0) > 5000) {
        issues.push(`External recall requests slow (${m.timing.externalTotal}ms) - inspect embed/rerank timings`);
    }

    if ((m.timing.unattributed || 0) > 500) {
        issues.push(`Unattributed recall time high (${m.timing.unattributed}ms) - add more timing probes around new work`);
    }

    if (m.query.buildTime > 100) {
        issues.push(`Slow query build (${m.query.buildTime}ms) - entity lexicon may be too large`);
    }

    if (m.evidence.l1CosineTime > 1000) {
        const dominantStage = [
            ['chunk DB', m.evidence.l1ChunkFetchTime || 0],
            ['vector DB', m.evidence.l1VectorFetchTime || 0],
            ['deserialize', m.evidence.l1DeserializeTime || 0],
            ['score', m.evidence.l1ScoreTime || 0],
            ['sort', m.evidence.l1SortTime || 0],
        ].sort((a, b) => b[1] - a[1])[0];
        issues.push(`Slow L1 scoring (${m.evidence.l1CosineTime}ms) - dominant stage: ${dominantStage[0]} ${dominantStage[1]}ms`);
    }

    // ─────────────────────────────────────────────────────────────────
    // Diffusion 问题
    // ─────────────────────────────────────────────────────────────────

    if (m.diffusion.graphEdges === 0 && m.diffusion.seedCount > 0) {
        issues.push('No diffusion graph edges - atoms may lack edges fields');
    }

    if (m.diffusion.pprActivated > 0 && m.diffusion.cosineGatePassed === 0) {
        issues.push('All PPR-activated nodes failed cosine gate - graph structure diverged from query semantics');
    }

    m.quality.diffusionEffectiveRate = m.diffusion.pprActivated > 0
        ? Math.round((m.diffusion.finalCount / m.diffusion.pprActivated) * 100)
        : 0;

    if (m.diffusion.cosineGateNoVector > 5) {
        issues.push(`${m.diffusion.cosineGateNoVector} PPR nodes missing vectors - L0 vectorization may be incomplete`);
    }

    if (m.diffusion.time > 50) {
        issues.push(`Slow diffusion (${m.diffusion.time}ms) - graph may be too dense`);
    }

    if (m.diffusion.pprActivated > 0 && (m.diffusion.postGatePassRate < 20 || m.diffusion.postGatePassRate > 60)) {
        issues.push(`Diffusion post-gate pass rate out of target (${m.diffusion.postGatePassRate}%)`);
    }

    return issues;
}
