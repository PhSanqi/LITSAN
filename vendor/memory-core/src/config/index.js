import { defaultLitsanHome, litsanEnv } from "../utils/litsan-compat.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID, resolveAssignedModel } from "../contracts/index.js";
import { resolveTimeZone } from "../utils/time.js";
const ACCOUNT_EVOLUTION_THINKING_BUDGET = 1_000;
const ASYNC_EVOLUTION_TIMEOUT_MS = 3 * 60_000;
export const MEMORY_SUMMARY_MAX_TOKENS = 512;
export const DEFAULT_LITSAN_CONFIG = {
    version: 1,
    domain: "",
    roleRouting: {
        summary: "follow",
        evolution: "follow"
    },
    storage: {
        mode: "local",
        backend: "sqlite",
        sqlitePath: join(defaultLitsanHome(), "memory-service", "memory.sqlite"),
        endpoint: "http://127.0.0.1:18960",
        token: undefined
    },
    summary: {
        provider: "",
        vendor: "",
        endpoint: undefined,
        model: "",
        apiKey: undefined,
        enableThinking: false,
        temperature: 0,
        maxTokens: MEMORY_SUMMARY_MAX_TOKENS,
        timeoutMs: 180_000,
        maxRetries: 3,
        malformedRetries: 1
    },
    evolution: {
        provider: "",
        vendor: "",
        endpoint: undefined,
        model: "",
        apiKey: undefined,
        enableThinking: true,
        temperature: 0,
        maxTokens: 4096,
        timeoutMs: ASYNC_EVOLUTION_TIMEOUT_MS,
        maxRetries: 2,
        malformedRetries: 1
    },
    embedding: {
        provider: "local",
        mode: "local",
        endpoint: undefined,
        model: "Xenova/all-MiniLM-L6-v2",
        apiKey: undefined,
        batchSize: 32,
        timeoutMs: 60_000,
        maxRetries: 2,
        cache: true,
        normalize: false
    },
    agentAccess: {
        autoScanKnownAgents: true,
        watchFileChanges: true,
        autoInjectSkill: false
    },
    algorithm: {
        enableMemoryAdd: true,
        enableMemorySearch: true,
        enableQueryRewrite: false,
        capture: {
            maxTextChars: 4_000,
            maxToolOutputChars: 2_000,
            synthReflection: true,
            embedAfterCapture: true,
            alphaScoring: true,
            batchMode: "windowed",
            batchThreshold: 12,
            reflectionContextMode: "task_downstream",
            longEpisodeReflectMode: "per_step_downstream",
            downstreamStepCount: 3,
            taskContextMaxChars: 800,
            downstreamContextMaxChars: 1_200,
            downstreamPerStepMaxChars: 400,
            synthOutcomeMaxChars: 600,
            reflectionBatchWindowSize: 6,
            reflectionBatchOverlap: 1,
            reflectionBatchDegradedWindowSize: 3,
            reflectionBatchDegradedOverlap: 1,
            reflectionBatchPrimaryMaxRetries: 1,
            reflectionBatchDegradedMaxRetries: 2,
            reflectionBatchStepStateChars: 600,
            reflectionBatchStepThinkingChars: 300,
            reflectionBatchStepActionChars: 600,
            reflectionBatchToolInputChars: 120,
            reflectionBatchToolOutputChars: 160,
            reflectionBatchToolErrorChars: 160,
            reflectionBatchOutcomeChars: 240,
            reflectionBatchReflectionChars: 300
        },
        reward: {
            llmScoring: true,
            gamma: 0.9,
            lambda: 0.5,
            delta: 0.1,
            tauSoftmax: 0.5,
            decayHalfLifeDays: 30,
            implicitThreshold: 0.2,
            feedbackWindowSec: 30,
            summaryMaxChars: 2_000,
            llmConcurrency: 2,
            minExchangesForCompletion: 1,
            minContentCharsForCompletion: 40,
            toolHeavyRatio: 0.7,
            minAssistantCharsForToolHeavy: 80
        },
        feedback: {
            failureThreshold: 3,
            failureWindow: 5,
            valueDelta: 0.5,
            minLowValueThreshold: 0.01,
            useLlm: true,
            cooldownMs: 60_000,
            traceCharCap: 500,
            evidenceLimit: 4
        },
        negativeExperience: {
            enabled: true,
            failureRTaskThreshold: -0.15,
            maxAntiPatterns: 3,
            maxPreferences: 3,
            maxSourceIds: 20,
            implicitConfidenceCap: 0.65
        },
        l2Induction: {
            useLlm: true,
            minEpisodesForInduction: 1,
            minEpisodesForActivation: 3,
            minSimilarity: 0.65,
            candidateTtlDays: 30,
            minTraceValue: 0.005,
            minGain: 0.02,
            archiveGain: -0.05,
            traceCharCap: 3_000,
            tauSoftmax: 0.5,
            gainEmaAlpha: 0.4
        },
        l3Abstraction: {
            useLlm: true,
            minPolicies: 1,
            minPolicyGain: 0.02,
            minPolicySupport: 1,
            clusterMinSimilarity: 0.3,
            policyCharCap: 800,
            traceCharCap: 500,
            traceEvidencePerPolicy: 1,
            cooldownDays: 0,
            confidenceDelta: 0.05,
            minConfidenceForRetrieval: 0.2
        },
        skill: {
            useLlm: true,
            minEtaForRetrieval: 0.1,
            minSupport: 1,
            minGain: 0.02,
            candidateTrials: 1,
            cooldownMs: 0,
            traceCharCap: 500,
            evidenceLimit: 6,
            etaDelta: 0.1,
            archiveEta: 0.1,
            repairCandidateMinEta: 0.5,
            outputLanguageMode: "follow_policy",
            outcomeRTaskSuccessThreshold: 0.5,
            outcomeRTaskFailureThreshold: -0.15,
            failureEpisodeScorePenalty: 0,
            failureEpisodeMaxRatio: 0.4
        },
        session: {
            followUpMode: "merge_follow_ups",
            mergeMaxGapMs: 2 * 60 * 60 * 1000
        },
        retrieval: {
            tier1TopK: 3,
            tier2TopK: 5,
            tier3TopK: 2,
            candidatePoolFactor: 4,
            weightCosine: 0.6,
            weightPriority: 0.4,
            mmrLambda: 0.7,
            rrfConstant: 60,
            relativeThresholdFloor: 0.2,
            minRecallScore: 0.12,
            minSkillEta: 0.1,
            minTraceSim: 0.25,
            episodeGoalMinSim: 0.45,
            includeLowValue: false,
            tagFilter: "auto",
            keywordTopK: 20,
            skillEtaBlend: 0.15,
            smartSeed: true,
            smartSeedRatio: 0.7,
            multiChannelBypass: true,
            skillInjectionMode: "summary",
            skillSummaryChars: 200,
            llmFilterEnabled: true,
            llmFilterMaxKeep: 8,
            llmFilterFallbackMaxKeep: 6,
            llmFilterMinCandidates: 2,
            llmFilterCandidateBodyChars: 500,
            readOnlyInjectionProfile: "all"
        }
    }
};
export function defaultConfigPaths() {
    return [
        litsanEnv("LITSAN_CONFIG", process.env),
        join(defaultLitsanHome(), "config.yaml")
    ].filter((value) => Boolean(value));
}
export function loadLitsanConfig(configPath) {
    const selectedPath = configPath
        ? resolve(configPath)
        : defaultConfigPaths().find((candidate) => existsSync(candidate))
            ?? defaultConfigPaths().at(-1);
    const rootConfig = selectedPath && existsSync(selectedPath)
        ? parseConfigFile(selectedPath)
        : {};
    const configuredTimeZone = optionalString(asRecord(asRecord(rootConfig.agents).defaults).timezone);
    const litsanMemoryConfig = asRecord((rootConfig.litsanMemory ?? rootConfig.memmyMemory));
    const fileConfig = resolveRuntimeLitsanMemoryConfig(litsanMemoryConfig, rootConfig);
    const envConfig = configFromEnv();
    const merged = normalizeConfig(deepMerge(DEFAULT_LITSAN_CONFIG, fileConfig, envConfig));
    return {
        config: {
            ...merged,
            ...(configuredTimeZone ? { timeZone: resolveTimeZone(configuredTimeZone) } : {})
        },
        path: selectedPath
    };
}
export function resolveEvolutionConfig(config) {
    return config.evolution;
}
function parseConfigFile(path) {
    const raw = readFileSync(path, "utf8");
    const parsed = parseYaml(raw);
    return isRecord(parsed) ? parsed : {};
}
function configFromEnv() {
    return compactRecord({
        domain: litsanEnv("LITSAN_MEMORY_DOMAIN", process.env) ?? litsanEnv("LITSAN_DOMAIN", process.env),
        userId: litsanEnv("LITSAN_MEMORY_USER_ID", process.env) ?? litsanEnv("LITSAN_USER_ID", process.env) ?? process.env.MEMORY_SERVICE_USER_ID,
        storage: compactRecord({
            mode: litsanEnv("LITSAN_MEMORY_MODE", process.env),
            backend: litsanEnv("LITSAN_MEMORY_BACKEND", process.env),
            sqlitePath: litsanEnv("LITSAN_MEMORY_DB", process.env) ?? process.env.MEMORY_SERVICE_DB,
            endpoint: litsanEnv("LITSAN_MEMORY_URL", process.env) ?? process.env.MEMORY_SERVICE_URL,
            token: litsanEnv("LITSAN_MEMORY_TOKEN", process.env) ?? process.env.MEMORY_SERVICE_TOKEN
        }),
        summary: compactRecord({
            provider: litsanEnv("LITSAN_SUMMARY_PROVIDER", process.env),
            vendor: litsanEnv("LITSAN_SUMMARY_VENDOR", process.env),
            endpoint: litsanEnv("LITSAN_SUMMARY_ENDPOINT", process.env),
            model: litsanEnv("LITSAN_SUMMARY_MODEL", process.env),
            apiKey: litsanEnv("LITSAN_SUMMARY_API_KEY", process.env),
            temperature: numberEnv("LITSAN_SUMMARY_TEMPERATURE"),
            maxTokens: numberEnv("LITSAN_SUMMARY_MAX_TOKENS"),
            timeoutMs: numberEnv("LITSAN_SUMMARY_TIMEOUT_MS"),
            maxRetries: numberEnv("LITSAN_SUMMARY_MAX_RETRIES")
        }),
        evolution: compactRecord({
            provider: litsanEnv("LITSAN_EVOLUTION_PROVIDER", process.env),
            vendor: litsanEnv("LITSAN_EVOLUTION_VENDOR", process.env),
            endpoint: litsanEnv("LITSAN_EVOLUTION_ENDPOINT", process.env),
            model: litsanEnv("LITSAN_EVOLUTION_MODEL", process.env),
            apiKey: litsanEnv("LITSAN_EVOLUTION_API_KEY", process.env),
            enableThinking: booleanEnv("LITSAN_EVOLUTION_ENABLE_THINKING"),
            temperature: numberEnv("LITSAN_EVOLUTION_TEMPERATURE"),
            maxTokens: numberEnv("LITSAN_EVOLUTION_MAX_TOKENS"),
            timeoutMs: numberEnv("LITSAN_EVOLUTION_TIMEOUT_MS"),
            maxRetries: numberEnv("LITSAN_EVOLUTION_MAX_RETRIES")
        }),
        embedding: compactRecord({
            provider: litsanEnv("LITSAN_EMBEDDING_PROVIDER", process.env),
            endpoint: litsanEnv("LITSAN_EMBEDDING_ENDPOINT", process.env),
            model: litsanEnv("LITSAN_EMBEDDING_MODEL", process.env),
            apiKey: litsanEnv("LITSAN_EMBEDDING_API_KEY", process.env),
            maxInputTokens: numberEnv("LITSAN_EMBEDDING_MAX_INPUT_TOKENS"),
            batchSize: numberEnv("LITSAN_EMBEDDING_BATCH_SIZE"),
            timeoutMs: numberEnv("LITSAN_EMBEDDING_TIMEOUT_MS"),
            maxRetries: numberEnv("LITSAN_EMBEDDING_MAX_RETRIES")
        }),
        algorithm: compactRecord({
            enableMemoryAdd: booleanEnv("LITSAN_ENABLE_MEMORY_ADD"),
            enableMemorySearch: booleanEnv("LITSAN_ENABLE_MEMORY_SEARCH"),
            enableQueryRewrite: booleanEnv("LITSAN_ENABLE_QUERY_REWRITE"),
            retrieval: compactRecord({
                readOnlyInjectionProfile: litsanEnv("LITSAN_RETRIEVAL_INJECTION_PROFILE", process.env) ??
                    litsanEnv("LITSAN_READONLY_INJECTION_PROFILE", process.env)
            })
        })
    });
}
function normalizeConfig(input) {
    const storage = normalizeStorage(asRecord(input.storage));
    const summary = {
        ...normalizeLlm(asRecord(input.summary), DEFAULT_LITSAN_CONFIG.summary),
        enableThinking: false
    };
    const normalizedEvolution = normalizeLlm(asRecord(input.evolution), DEFAULT_LITSAN_CONFIG.evolution);
    const evolution = input.evolutionSourceProvider === "memmy_account"
        ? {
            ...normalizedEvolution,
            thinkingBudget: ACCOUNT_EVOLUTION_THINKING_BUDGET,
            timeoutMs: ASYNC_EVOLUTION_TIMEOUT_MS
        }
        : normalizedEvolution;
    const embedding = normalizeEmbedding(asRecord(input.embedding));
    const agentAccess = normalizeAgentAccess(asRecord(input.agentAccess));
    const algorithm = normalizeAlgorithm(asRecord(input.algorithm));
    return {
        version: 1,
        domain: memoryDomainName(input.domain, DEFAULT_LITSAN_CONFIG.domain),
        roleRouting: normalizeRoleRouting(asRecord(input.roleRouting)),
        userId: optionalString(input.userId),
        storage,
        summary,
        evolution,
        embedding,
        agentAccess,
        algorithm
    };
}
function resolveRuntimeLitsanMemoryConfig(input, rootConfig) {
    if (Object.prototype.hasOwnProperty.call(input, "profiles")
        || Object.prototype.hasOwnProperty.call(input, "activeProfile")) {
        throw new Error("litsanMemory legacy profiles require the registered runtime config migration");
    }
    const routing = normalizeRoleRouting(asRecord(input.roleRouting));
    const assignmentMode = runtimeAssignmentMode(rootConfig);
    const hasCatalog = isRecord(rootConfig.modelAssignments);
    const accountMode = assignmentMode === "account" && hasCatalog;
    const evolution = accountMode
        ? resolveAssignedLlm(rootConfig, assignmentMode, "memory_evolution", DEFAULT_LITSAN_CONFIG.evolution)
        : routing.evolution === "follow" && hasCatalog
            ? resolveAssignedLlm(rootConfig, assignmentMode, "agent", DEFAULT_LITSAN_CONFIG.evolution)
            : asRecord(input.evolution);
    const rawSummary = asRecord(input.summary);
    // Account assignments are authoritative for both roles, even when an old
    // config file contains a stale fixed connection from another mode.
    const accountSummaryNeedsAssignment = accountMode;
    const summary = accountSummaryNeedsAssignment
        ? resolveAssignedLlm(rootConfig, assignmentMode, "memory_summary", DEFAULT_LITSAN_CONFIG.summary)
        : routing.summary === "follow" && assignmentMode !== "account"
            ? inheritLlmConnection(evolution, deepMerge(DEFAULT_LITSAN_CONFIG.summary, rawSummary))
            : rawSummary;
    const effectiveRouting = assignmentMode === "account"
        ? { ...routing, summary: "fixed", evolution: "fixed" }
        : routing;
    return {
        ...input,
        roleRouting: effectiveRouting,
        summary,
        evolution,
        evolutionSourceProvider: optionalString(evolution.sourceProvider),
        embedding: resolveMemoryEmbedding(input, rootConfig, assignmentMode, hasCatalog)
    };
}
function normalizeStorage(input) {
    return {
        mode: storageMode(input.mode, DEFAULT_LITSAN_CONFIG.storage.mode),
        backend: storageBackend(input.backend, DEFAULT_LITSAN_CONFIG.storage.backend),
        sqlitePath: optionalPathString(input.sqlitePath),
        endpoint: optionalString(input.endpoint) ?? DEFAULT_LITSAN_CONFIG.storage.endpoint,
        token: optionalString(input.token)
    };
}
function normalizeLlm(input, defaults) {
    return {
        provider: llmProvider(input.provider, defaults.provider),
        sourceProvider: optionalString(input.sourceProvider)
            ?? optionalString(input.vendor)
            ?? optionalString(input.provider)
            ?? defaults.sourceProvider,
        vendor: llmVendor(input.vendor, defaults.vendor ?? ""),
        endpoint: optionalString(input.endpoint),
        model: optionalString(input.model) ?? defaults.model,
        apiKey: optionalString(input.apiKey),
        extraHeaders: stringRecord(input.extraHeaders),
        extraBody: unknownRecord(input.extraBody),
        actualModelContext: actualModelContext(input.actualModelContext),
        selectionError: input.selectionError === "model_selection_unavailable"
            ? input.selectionError
            : undefined,
        enableThinking: booleanValue(input.enableThinking, defaults.enableThinking),
        temperature: numberValue(input.temperature, defaults.temperature),
        maxTokens: numberValue(input.maxTokens, defaults.maxTokens ?? 1200),
        timeoutMs: numberValue(input.timeoutMs, defaults.timeoutMs),
        maxRetries: numberValue(input.maxRetries, defaults.maxRetries),
        malformedRetries: numberValue(input.malformedRetries, defaults.malformedRetries)
    };
}
function normalizeEmbedding(input) {
    return {
        provider: embeddingProvider(input.provider, DEFAULT_LITSAN_CONFIG.embedding.provider),
        mode: memoryEmbeddingMode(input.mode, DEFAULT_LITSAN_CONFIG.embedding.mode),
        sourceProvider: optionalString(input.sourceProvider),
        endpoint: optionalString(input.endpoint),
        model: optionalString(input.model) ?? DEFAULT_LITSAN_CONFIG.embedding.model,
        apiKey: optionalString(input.apiKey),
        extraHeaders: stringRecord(input.extraHeaders),
        extraBody: unknownRecord(input.extraBody),
        actualModelContext: actualModelContext(input.actualModelContext),
        selectionError: input.selectionError === "model_selection_unavailable"
            ? input.selectionError
            : undefined,
        maxInputTokens: positiveInteger(input.maxInputTokens),
        batchSize: numberValue(input.batchSize, DEFAULT_LITSAN_CONFIG.embedding.batchSize),
        timeoutMs: numberValue(input.timeoutMs, DEFAULT_LITSAN_CONFIG.embedding.timeoutMs),
        maxRetries: numberValue(input.maxRetries, DEFAULT_LITSAN_CONFIG.embedding.maxRetries),
        cache: booleanValue(input.cache, DEFAULT_LITSAN_CONFIG.embedding.cache),
        normalize: booleanValue(input.normalize, DEFAULT_LITSAN_CONFIG.embedding.normalize)
    };
}
function normalizeAgentAccess(input) {
    return {
        autoScanKnownAgents: booleanValue(input.autoScanKnownAgents, DEFAULT_LITSAN_CONFIG.agentAccess.autoScanKnownAgents),
        watchFileChanges: booleanValue(input.watchFileChanges, DEFAULT_LITSAN_CONFIG.agentAccess.watchFileChanges),
        autoInjectSkill: booleanValue(input.autoInjectSkill, DEFAULT_LITSAN_CONFIG.agentAccess.autoInjectSkill)
    };
}
function normalizeRoleRouting(input) {
    return {
        summary: memoryRoleRouting(input.summary, DEFAULT_LITSAN_CONFIG.roleRouting.summary),
        evolution: memoryRoleRouting(input.evolution, DEFAULT_LITSAN_CONFIG.roleRouting.evolution)
    };
}
function resolveAssignedLlm(rootConfig, mode, capability, defaults) {
    const resolved = resolveMemoryAssignment(rootConfig, mode, capability);
    if (!resolved.ok || !llmProtocolSupported(resolved.context.protocol)) {
        return unavailableLlm(defaults);
    }
    const runtimeProvider = memoryLlmProvider(resolved.context.provider);
    return {
        ...defaults,
        provider: runtimeProvider,
        sourceProvider: resolved.context.provider,
        vendor: memoryLlmVendor(resolved.context.provider, runtimeProvider),
        endpoint: resolved.provider.apiBase,
        model: resolved.context.model,
        apiKey: resolved.provider.apiKey,
        extraHeaders: resolved.provider.extraHeaders,
        extraBody: resolved.provider.extraBody,
        actualModelContext: resolved.context
    };
}
function inheritLlmConnection(source, target) {
    const inherited = { ...target };
    for (const key of [
        "provider",
        "sourceProvider",
        "vendor",
        "endpoint",
        "model",
        "apiKey",
        "extraHeaders",
        "extraBody",
        "actualModelContext",
        "selectionError"
    ]) {
        inherited[key] = source[key];
    }
    return inherited;
}
function unavailableLlm(defaults) {
    return {
        ...defaults,
        provider: "",
        model: "",
        selectionError: "model_selection_unavailable"
    };
}
function memoryLlmProvider(provider) {
    switch (provider) {
        case "anthropic":
            return "anthropic";
        case "google":
        case "gemini":
            return "gemini";
        case "bedrock":
            return "bedrock";
        case "host":
            return "host";
        default:
            return "openai_compatible";
    }
}
function memoryLlmVendor(provider, runtimeProvider) {
    switch (provider) {
        case "anthropic":
            return "anthropic";
        case "google":
        case "gemini":
            return "google";
        case "deepseek":
        case "zhipu":
        case "qwen":
        case "dashscope":
        case "kimi":
        case "moonshot":
        case "minimax":
        case "baidu":
        case "qianfan":
        case "doubao":
        case "volcengine":
            return {
                dashscope: "qwen",
                moonshot: "kimi",
                qianfan: "baidu",
                volcengine: "doubao"
            }[provider]
                ?? provider;
        default:
            return runtimeProvider === "openai_compatible" ? "openai_compatible" : "";
    }
}
function resolveMemoryEmbedding(memory, rootConfig, mode, hasCatalog) {
    const embedding = asRecord(memory.embedding);
    const configuredMode = optionalString(embedding.mode);
    const embeddingMode = configuredMode === "cloud"
        || configuredMode === "local"
        || configuredMode === "custom"
        ? configuredMode
        : mode === "account" && hasCatalog
            ? "cloud"
            : DEFAULT_LITSAN_CONFIG.embedding.mode;
    const activeAssignment = mode
        ? asRecord(asRecord(rootConfig.modelAssignments)[mode])
        : {};
    const rawAssignedPreset = activeAssignment.embedding;
    const hasExplicitAssignment = rawAssignedPreset !== undefined && rawAssignedPreset !== null;
    if (rawAssignedPreset === BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID) {
        const assignmentOwner = optionalString(activeAssignment.ownerAccountId);
        const activeAccountId = optionalString(asRecord(rootConfig.app).userId);
        if (mode === "account"
            && (!assignmentOwner || !activeAccountId || assignmentOwner !== activeAccountId)) {
            return {
                ...embedding,
                mode: "cloud",
                provider: "openai_compatible",
                model: "",
                selectionError: "model_selection_unavailable"
            };
        }
        return localEmbeddingConfig(embedding);
    }
    if (mode === "account" && !hasExplicitAssignment) {
        return {
            ...embedding,
            mode: "cloud",
            provider: "openai_compatible",
            model: "",
            selectionError: "model_selection_unavailable"
        };
    }
    const resolved = resolveMemoryAssignment(rootConfig, mode, "embedding");
    if (mode === "byok" && hasCatalog && !hasExplicitAssignment) {
        return localEmbeddingConfig(embedding);
    }
    if (embeddingMode === "local") {
        if (hasExplicitAssignment && !resolved.ok) {
            return {
                ...embedding,
                provider: "openai_compatible",
                model: "",
                selectionError: "model_selection_unavailable"
            };
        }
        return localEmbeddingConfig(embedding);
    }
    if (embeddingMode === "custom") {
        const custom = asRecord(embedding.custom);
        return {
            ...embedding,
            ...custom,
            mode: embeddingMode,
            provider: optionalString(custom.provider)
                ?? optionalString(embedding.provider)
                ?? DEFAULT_LITSAN_CONFIG.embedding.provider
        };
    }
    if (!hasCatalog) {
        return {
            ...embedding,
            mode: "cloud",
            provider: "openai_compatible",
            model: "",
            selectionError: "model_selection_unavailable"
        };
    }
    if (!resolved.ok) {
        return {
            ...embedding,
            mode: "cloud",
            provider: "openai_compatible",
            model: "",
            selectionError: "model_selection_unavailable"
        };
    }
    if (!embeddingProtocolSupported(resolved.context.protocol)) {
        return {
            ...embedding,
            provider: "openai_compatible",
            model: "",
            selectionError: "model_selection_unavailable"
        };
    }
    return {
        ...embedding,
        mode: resolved.context.source === "account" ? "cloud" : "custom",
        sourceProvider: resolved.context.provider,
        provider: "openai_compatible",
        endpoint: resolved.provider.apiBase,
        model: resolved.context.model,
        apiKey: resolved.provider.apiKey,
        extraHeaders: resolved.provider.extraHeaders,
        extraBody: resolved.provider.extraBody,
        actualModelContext: resolved.context
    };
}
function localEmbeddingConfig(embedding) {
    return {
        ...embedding,
        mode: "local",
        provider: "local",
        sourceProvider: "local",
        endpoint: undefined,
        model: DEFAULT_LITSAN_CONFIG.embedding.model,
        apiKey: undefined,
        extraHeaders: undefined,
        extraBody: undefined,
        actualModelContext: undefined,
        selectionError: undefined
    };
}
function resolveMemoryAssignment(rootConfig, mode, capability) {
    if (!mode)
        return { ok: false, code: "model_selection_unavailable" };
    return resolveAssignedModel({
        catalog: rootConfig,
        mode,
        activeAccountId: optionalString(asRecord(rootConfig.app).userId),
        capability
    });
}
function runtimeAssignmentMode(rootConfig) {
    const mode = optionalString(asRecord(rootConfig.app).userMode);
    return mode === "account" || mode === "byok" ? mode : null;
}
function llmProtocolSupported(protocol) {
    return protocol === "openai-chat-completions"
        || protocol === "anthropic-messages"
        || protocol === "gemini-generate-content"
        || protocol === "memmy-account";
}
function embeddingProtocolSupported(protocol) {
    return protocol === "openai-embeddings" || protocol === "memmy-account";
}
function normalizeAlgorithm(input) {
    const capture = asRecord(input.capture);
    const reward = asRecord(input.reward);
    const feedback = asRecord(input.feedback);
    const negativeExperience = asRecord(input.negativeExperience);
    const l2 = asRecord(input.l2Induction);
    const l3 = asRecord(input.l3Abstraction);
    const skill = asRecord(input.skill);
    const session = asRecord(input.session);
    const retrieval = asRecord(input.retrieval);
    return {
        enableMemoryAdd: booleanValue(input.enableMemoryAdd, DEFAULT_LITSAN_CONFIG.algorithm.enableMemoryAdd),
        enableMemorySearch: booleanValue(input.enableMemorySearch, DEFAULT_LITSAN_CONFIG.algorithm.enableMemorySearch),
        enableQueryRewrite: booleanValue(input.enableQueryRewrite, DEFAULT_LITSAN_CONFIG.algorithm.enableQueryRewrite),
        capture: {
            maxTextChars: numberValue(capture.maxTextChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.maxTextChars),
            maxToolOutputChars: numberValue(capture.maxToolOutputChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.maxToolOutputChars),
            synthReflection: booleanValue(capture.synthReflection, DEFAULT_LITSAN_CONFIG.algorithm.capture.synthReflection),
            embedAfterCapture: booleanValue(capture.embedAfterCapture, DEFAULT_LITSAN_CONFIG.algorithm.capture.embedAfterCapture),
            alphaScoring: booleanValue(capture.alphaScoring, DEFAULT_LITSAN_CONFIG.algorithm.capture.alphaScoring),
            batchMode: captureBatchMode(capture.batchMode, DEFAULT_LITSAN_CONFIG.algorithm.capture.batchMode),
            batchThreshold: numberValue(capture.batchThreshold, DEFAULT_LITSAN_CONFIG.algorithm.capture.batchThreshold),
            reflectionContextMode: reflectionContextMode(capture.reflectionContextMode, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionContextMode),
            longEpisodeReflectMode: longEpisodeReflectMode(capture.longEpisodeReflectMode, DEFAULT_LITSAN_CONFIG.algorithm.capture.longEpisodeReflectMode),
            downstreamStepCount: numberValue(capture.downstreamStepCount, DEFAULT_LITSAN_CONFIG.algorithm.capture.downstreamStepCount),
            taskContextMaxChars: numberValue(capture.taskContextMaxChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.taskContextMaxChars),
            downstreamContextMaxChars: numberValue(capture.downstreamContextMaxChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.downstreamContextMaxChars),
            downstreamPerStepMaxChars: numberValue(capture.downstreamPerStepMaxChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.downstreamPerStepMaxChars),
            synthOutcomeMaxChars: numberValue(capture.synthOutcomeMaxChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.synthOutcomeMaxChars),
            reflectionBatchWindowSize: numberValue(capture.reflectionBatchWindowSize, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchWindowSize),
            reflectionBatchOverlap: numberValue(capture.reflectionBatchOverlap, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchOverlap),
            reflectionBatchDegradedWindowSize: numberValue(capture.reflectionBatchDegradedWindowSize, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchDegradedWindowSize),
            reflectionBatchDegradedOverlap: numberValue(capture.reflectionBatchDegradedOverlap, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchDegradedOverlap),
            reflectionBatchPrimaryMaxRetries: numberValue(capture.reflectionBatchPrimaryMaxRetries, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchPrimaryMaxRetries),
            reflectionBatchDegradedMaxRetries: numberValue(capture.reflectionBatchDegradedMaxRetries, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchDegradedMaxRetries),
            reflectionBatchStepStateChars: numberValue(capture.reflectionBatchStepStateChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchStepStateChars),
            reflectionBatchStepThinkingChars: numberValue(capture.reflectionBatchStepThinkingChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchStepThinkingChars),
            reflectionBatchStepActionChars: numberValue(capture.reflectionBatchStepActionChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchStepActionChars),
            reflectionBatchToolInputChars: numberValue(capture.reflectionBatchToolInputChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchToolInputChars),
            reflectionBatchToolOutputChars: numberValue(capture.reflectionBatchToolOutputChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchToolOutputChars),
            reflectionBatchToolErrorChars: numberValue(capture.reflectionBatchToolErrorChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchToolErrorChars),
            reflectionBatchOutcomeChars: numberValue(capture.reflectionBatchOutcomeChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchOutcomeChars),
            reflectionBatchReflectionChars: numberValue(capture.reflectionBatchReflectionChars, DEFAULT_LITSAN_CONFIG.algorithm.capture.reflectionBatchReflectionChars)
        },
        reward: {
            llmScoring: booleanValue(reward.llmScoring, DEFAULT_LITSAN_CONFIG.algorithm.reward.llmScoring),
            gamma: numberValue(reward.gamma, DEFAULT_LITSAN_CONFIG.algorithm.reward.gamma),
            lambda: numberValue(reward.lambda, DEFAULT_LITSAN_CONFIG.algorithm.reward.lambda),
            delta: numberValue(reward.delta, DEFAULT_LITSAN_CONFIG.algorithm.reward.delta),
            tauSoftmax: numberValue(reward.tauSoftmax, DEFAULT_LITSAN_CONFIG.algorithm.reward.tauSoftmax),
            decayHalfLifeDays: numberValue(reward.decayHalfLifeDays, DEFAULT_LITSAN_CONFIG.algorithm.reward.decayHalfLifeDays),
            implicitThreshold: numberValue(reward.implicitThreshold, DEFAULT_LITSAN_CONFIG.algorithm.reward.implicitThreshold),
            feedbackWindowSec: numberValue(reward.feedbackWindowSec, DEFAULT_LITSAN_CONFIG.algorithm.reward.feedbackWindowSec),
            summaryMaxChars: numberValue(reward.summaryMaxChars, DEFAULT_LITSAN_CONFIG.algorithm.reward.summaryMaxChars),
            llmConcurrency: numberValue(reward.llmConcurrency, DEFAULT_LITSAN_CONFIG.algorithm.reward.llmConcurrency),
            minExchangesForCompletion: numberValue(reward.minExchangesForCompletion, DEFAULT_LITSAN_CONFIG.algorithm.reward.minExchangesForCompletion),
            minContentCharsForCompletion: numberValue(reward.minContentCharsForCompletion, DEFAULT_LITSAN_CONFIG.algorithm.reward.minContentCharsForCompletion),
            toolHeavyRatio: numberValue(reward.toolHeavyRatio, DEFAULT_LITSAN_CONFIG.algorithm.reward.toolHeavyRatio),
            minAssistantCharsForToolHeavy: numberValue(reward.minAssistantCharsForToolHeavy, DEFAULT_LITSAN_CONFIG.algorithm.reward.minAssistantCharsForToolHeavy)
        },
        feedback: {
            failureThreshold: numberValue(feedback.failureThreshold, DEFAULT_LITSAN_CONFIG.algorithm.feedback.failureThreshold),
            failureWindow: numberValue(feedback.failureWindow, DEFAULT_LITSAN_CONFIG.algorithm.feedback.failureWindow),
            valueDelta: numberValue(feedback.valueDelta, DEFAULT_LITSAN_CONFIG.algorithm.feedback.valueDelta),
            minLowValueThreshold: numberValue(feedback.minLowValueThreshold, DEFAULT_LITSAN_CONFIG.algorithm.feedback.minLowValueThreshold),
            useLlm: booleanValue(feedback.useLlm, DEFAULT_LITSAN_CONFIG.algorithm.feedback.useLlm),
            cooldownMs: numberValue(feedback.cooldownMs, DEFAULT_LITSAN_CONFIG.algorithm.feedback.cooldownMs),
            traceCharCap: numberValue(feedback.traceCharCap, DEFAULT_LITSAN_CONFIG.algorithm.feedback.traceCharCap),
            evidenceLimit: numberValue(feedback.evidenceLimit, DEFAULT_LITSAN_CONFIG.algorithm.feedback.evidenceLimit)
        },
        negativeExperience: {
            enabled: booleanValue(negativeExperience.enabled, DEFAULT_LITSAN_CONFIG.algorithm.negativeExperience.enabled),
            failureRTaskThreshold: numberValue(negativeExperience.failureRTaskThreshold, DEFAULT_LITSAN_CONFIG.algorithm.negativeExperience.failureRTaskThreshold),
            maxAntiPatterns: numberValue(negativeExperience.maxAntiPatterns, DEFAULT_LITSAN_CONFIG.algorithm.negativeExperience.maxAntiPatterns),
            maxPreferences: numberValue(negativeExperience.maxPreferences, DEFAULT_LITSAN_CONFIG.algorithm.negativeExperience.maxPreferences),
            maxSourceIds: numberValue(negativeExperience.maxSourceIds, DEFAULT_LITSAN_CONFIG.algorithm.negativeExperience.maxSourceIds),
            implicitConfidenceCap: numberValue(negativeExperience.implicitConfidenceCap, DEFAULT_LITSAN_CONFIG.algorithm.negativeExperience.implicitConfidenceCap)
        },
        l2Induction: {
            useLlm: booleanValue(l2.useLlm, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.useLlm),
            minEpisodesForInduction: numberValue(l2.minEpisodesForInduction, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.minEpisodesForInduction),
            minEpisodesForActivation: numberValue(l2.minEpisodesForActivation, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.minEpisodesForActivation),
            minSimilarity: numberValue(l2.minSimilarity, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.minSimilarity),
            candidateTtlDays: numberValue(l2.candidateTtlDays, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.candidateTtlDays),
            minTraceValue: numberValue(l2.minTraceValue, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.minTraceValue),
            minGain: numberValue(l2.minGain, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.minGain),
            archiveGain: numberValue(l2.archiveGain, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.archiveGain),
            traceCharCap: numberValue(l2.traceCharCap, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.traceCharCap),
            tauSoftmax: numberValue(l2.tauSoftmax, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.tauSoftmax),
            gainEmaAlpha: numberValue(l2.gainEmaAlpha, DEFAULT_LITSAN_CONFIG.algorithm.l2Induction.gainEmaAlpha)
        },
        l3Abstraction: {
            useLlm: booleanValue(l3.useLlm, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.useLlm),
            minPolicies: numberValue(l3.minPolicies, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.minPolicies),
            minPolicyGain: numberValue(l3.minPolicyGain, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.minPolicyGain),
            minPolicySupport: numberValue(l3.minPolicySupport, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.minPolicySupport),
            clusterMinSimilarity: numberValue(l3.clusterMinSimilarity, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.clusterMinSimilarity),
            policyCharCap: numberValue(l3.policyCharCap, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.policyCharCap),
            traceCharCap: numberValue(l3.traceCharCap, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.traceCharCap),
            traceEvidencePerPolicy: numberValue(l3.traceEvidencePerPolicy, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.traceEvidencePerPolicy),
            cooldownDays: numberValue(l3.cooldownDays, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.cooldownDays),
            confidenceDelta: numberValue(l3.confidenceDelta, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.confidenceDelta),
            minConfidenceForRetrieval: numberValue(l3.minConfidenceForRetrieval, DEFAULT_LITSAN_CONFIG.algorithm.l3Abstraction.minConfidenceForRetrieval)
        },
        skill: {
            useLlm: booleanValue(skill.useLlm, DEFAULT_LITSAN_CONFIG.algorithm.skill.useLlm),
            minEtaForRetrieval: numberValue(skill.minEtaForRetrieval, DEFAULT_LITSAN_CONFIG.algorithm.skill.minEtaForRetrieval),
            minSupport: numberValue(skill.minSupport, DEFAULT_LITSAN_CONFIG.algorithm.skill.minSupport),
            minGain: numberValue(skill.minGain, DEFAULT_LITSAN_CONFIG.algorithm.skill.minGain),
            candidateTrials: numberValue(skill.candidateTrials, DEFAULT_LITSAN_CONFIG.algorithm.skill.candidateTrials),
            cooldownMs: numberValue(skill.cooldownMs, DEFAULT_LITSAN_CONFIG.algorithm.skill.cooldownMs),
            traceCharCap: numberValue(skill.traceCharCap, DEFAULT_LITSAN_CONFIG.algorithm.skill.traceCharCap),
            evidenceLimit: numberValue(skill.evidenceLimit, DEFAULT_LITSAN_CONFIG.algorithm.skill.evidenceLimit),
            etaDelta: numberValue(skill.etaDelta, DEFAULT_LITSAN_CONFIG.algorithm.skill.etaDelta),
            archiveEta: numberValue(skill.archiveEta, DEFAULT_LITSAN_CONFIG.algorithm.skill.archiveEta),
            repairCandidateMinEta: numberValue(skill.repairCandidateMinEta, DEFAULT_LITSAN_CONFIG.algorithm.skill.repairCandidateMinEta),
            outputLanguageMode: skillOutputLanguageMode(skill.outputLanguageMode, DEFAULT_LITSAN_CONFIG.algorithm.skill.outputLanguageMode),
            outcomeRTaskSuccessThreshold: numberValue(skill.outcomeRTaskSuccessThreshold, DEFAULT_LITSAN_CONFIG.algorithm.skill.outcomeRTaskSuccessThreshold),
            outcomeRTaskFailureThreshold: numberValue(skill.outcomeRTaskFailureThreshold, DEFAULT_LITSAN_CONFIG.algorithm.skill.outcomeRTaskFailureThreshold),
            failureEpisodeScorePenalty: numberValue(skill.failureEpisodeScorePenalty, DEFAULT_LITSAN_CONFIG.algorithm.skill.failureEpisodeScorePenalty),
            failureEpisodeMaxRatio: numberValue(skill.failureEpisodeMaxRatio, DEFAULT_LITSAN_CONFIG.algorithm.skill.failureEpisodeMaxRatio)
        },
        session: {
            followUpMode: "merge_follow_ups",
            mergeMaxGapMs: numberValue(session.mergeMaxGapMs, DEFAULT_LITSAN_CONFIG.algorithm.session.mergeMaxGapMs)
        },
        retrieval: {
            tier1TopK: numberValue(retrieval.tier1TopK, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.tier1TopK),
            tier2TopK: numberValue(retrieval.tier2TopK, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.tier2TopK),
            tier3TopK: numberValue(retrieval.tier3TopK, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.tier3TopK),
            candidatePoolFactor: numberValue(retrieval.candidatePoolFactor, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.candidatePoolFactor),
            weightCosine: numberValue(retrieval.weightCosine, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.weightCosine),
            weightPriority: numberValue(retrieval.weightPriority, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.weightPriority),
            mmrLambda: numberValue(retrieval.mmrLambda, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.mmrLambda),
            rrfConstant: numberValue(retrieval.rrfConstant, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.rrfConstant),
            relativeThresholdFloor: numberValue(retrieval.relativeThresholdFloor, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.relativeThresholdFloor),
            minRecallScore: numberValue(retrieval.minRecallScore, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.minRecallScore),
            minSkillEta: numberValue(retrieval.minSkillEta, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.minSkillEta),
            minTraceSim: numberValue(retrieval.minTraceSim, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.minTraceSim),
            episodeGoalMinSim: numberValue(retrieval.episodeGoalMinSim, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.episodeGoalMinSim),
            includeLowValue: booleanValue(retrieval.includeLowValue, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.includeLowValue),
            tagFilter: retrievalTagFilter(retrieval.tagFilter, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.tagFilter),
            keywordTopK: numberValue(retrieval.keywordTopK, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.keywordTopK),
            skillEtaBlend: numberValue(retrieval.skillEtaBlend, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.skillEtaBlend),
            smartSeed: booleanValue(retrieval.smartSeed, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.smartSeed),
            smartSeedRatio: numberValue(retrieval.smartSeedRatio, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.smartSeedRatio),
            multiChannelBypass: booleanValue(retrieval.multiChannelBypass, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.multiChannelBypass),
            skillInjectionMode: skillInjectionMode(retrieval.skillInjectionMode, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.skillInjectionMode),
            skillSummaryChars: numberValue(retrieval.skillSummaryChars, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.skillSummaryChars),
            llmFilterEnabled: booleanValue(retrieval.llmFilterEnabled, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.llmFilterEnabled),
            llmFilterMaxKeep: numberValue(retrieval.llmFilterMaxKeep, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.llmFilterMaxKeep),
            llmFilterFallbackMaxKeep: numberValue(retrieval.llmFilterFallbackMaxKeep, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.llmFilterFallbackMaxKeep),
            llmFilterMinCandidates: numberValue(retrieval.llmFilterMinCandidates, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.llmFilterMinCandidates),
            llmFilterCandidateBodyChars: numberValue(retrieval.llmFilterCandidateBodyChars, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.llmFilterCandidateBodyChars),
            readOnlyInjectionProfile: readOnlyInjectionProfile(retrieval.readOnlyInjectionProfile, DEFAULT_LITSAN_CONFIG.algorithm.retrieval.readOnlyInjectionProfile)
        }
    };
}
function memoryDomainName(value, fallback) {
    const domain = optionalString(value);
    if (domain === "" || domain === "research")
        return domain;
    return fallback;
}
function readOnlyInjectionProfile(value, fallback) {
    const profile = optionalString(value);
    if (profile === "experience") return "timeline";
    if (profile === "skill_experience") return "skill_timeline";
    if (profile === "all" || profile === "timeline" || profile === "skill" || profile === "skill_timeline") return profile;
    return fallback;
}
function skillOutputLanguageMode(value, fallback) {
    const mode = optionalString(value);
    if (mode === "follow_policy" || mode === "zh" || mode === "en")
        return mode;
    return fallback;
}
function retrievalTagFilter(value, fallback) {
    const mode = optionalString(value);
    if (mode === "auto" || mode === "on" || mode === "off")
        return mode;
    return fallback;
}
function skillInjectionMode(value, fallback) {
    const mode = optionalString(value);
    if (mode === "summary" || mode === "full")
        return mode;
    return fallback;
}
function llmProvider(value, fallback) {
    const provider = optionalString(value);
    if (provider === "" ||
        provider === "local_only" ||
        provider === "openai_compatible" ||
        provider === "gemini" ||
        provider === "anthropic" ||
        provider === "bedrock" ||
        provider === "host") {
        return provider;
    }
    return fallback;
}
function llmVendor(value, fallback) {
    const vendor = optionalString(value);
    if (vendor === "" ||
        vendor === "openai_compatible" ||
        vendor === "anthropic" ||
        vendor === "google" ||
        vendor === "deepseek" ||
        vendor === "zhipu" ||
        vendor === "qwen" ||
        vendor === "kimi" ||
        vendor === "minimax" ||
        vendor === "baidu" ||
        vendor === "doubao") {
        return vendor;
    }
    return fallback;
}
function embeddingProvider(value, fallback) {
    const provider = optionalString(value);
    if (provider === "local" ||
        provider === "openai_compatible" ||
        provider === "gemini" ||
        provider === "cohere" ||
        provider === "voyage" ||
        provider === "mistral") {
        return provider;
    }
    return fallback;
}
function storageMode(value, fallback) {
    const mode = optionalString(value);
    if (mode === "local" || mode === "cloud" || mode === "dev") {
        return mode;
    }
    return fallback;
}
function memoryRoleRouting(value, fallback) {
    const routing = optionalString(value);
    return routing === "follow" || routing === "fixed" ? routing : fallback;
}
function memoryEmbeddingMode(value, fallback) {
    const mode = optionalString(value);
    return mode === "cloud" || mode === "local" || mode === "custom"
        ? mode
        : fallback;
}
function storageBackend(value, fallback) {
    const backend = optionalString(value);
    if (backend === "sqlite" || backend === "openmem-cloud-rest") {
        return backend;
    }
    return fallback;
}
function captureBatchMode(value, fallback) {
    const mode = optionalString(value);
    if (mode === "windowed") {
        return mode;
    }
    return fallback;
}
function reflectionContextMode(value, fallback) {
    const mode = optionalString(value);
    if (mode === "none" || mode === "task" || mode === "downstream" || mode === "task_downstream") {
        return mode;
    }
    return fallback;
}
function longEpisodeReflectMode(value, fallback) {
    const mode = optionalString(value);
    if (mode === "per_step_parallel" || mode === "per_step_downstream") {
        return mode;
    }
    return fallback;
}
function deepMerge(...values) {
    const out = {};
    for (const value of values) {
        for (const [key, next] of Object.entries(value)) {
            const current = out[key];
            out[key] = isRecord(current) && isRecord(next)
                ? deepMerge(current, next)
                : next;
        }
    }
    return out;
}
function compactRecord(input) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined &&
        (!isRecord(value) || Object.keys(value).length > 0)));
}
function numberEnv(name) {
    const value = litsanEnv(name, process.env);
    if (!value)
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function booleanEnv(name) {
    const value = litsanEnv(name, process.env)?.trim().toLowerCase();
    if (!value)
        return undefined;
    if (value === "1" || value === "true" || value === "yes" || value === "on")
        return true;
    if (value === "0" || value === "false" || value === "no" || value === "off")
        return false;
    return undefined;
}
function optionalString(value) {
    return typeof value === "string" ? expandEnvString(value) : undefined;
}
function stringRecord(value) {
    if (!isRecord(value))
        return undefined;
    const entries = Object.entries(value);
    return entries.every((entry) => typeof entry[1] === "string")
        ? Object.fromEntries(entries)
        : undefined;
}
function unknownRecord(value) {
    return isRecord(value) ? { ...value } : undefined;
}
function actualModelContext(value) {
    if (!isRecord(value) || !Array.isArray(value.capabilities))
        return undefined;
    return value;
}
function optionalPathString(value) {
    if (typeof value !== "string")
        return undefined;
    const expanded = expandEnvString(value);
    return expanded === "~" || expanded.startsWith("~/")
        ? join(homedir(), expanded.slice(2))
        : expanded;
}
function expandEnvString(value) {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => litsanEnv(name, process.env) ?? "");
}
function numberValue(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function positiveInteger(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}
function booleanValue(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
function asRecord(value) {
    return isRecord(value) ? value : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
