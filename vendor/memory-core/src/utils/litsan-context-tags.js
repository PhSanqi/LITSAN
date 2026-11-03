export const LITSAN_MEMORY_CONTEXT_TAG = "litsan_memory_context";
export const CURRENT_USER_REQUEST_TAG = "current_user_request";
const MEMORY_CONTEXT_TAGS = [
    LITSAN_MEMORY_CONTEXT_TAG,
    "memmy_memory_context",
    "memos_context",
    "memory_context",
];
export function sanitizeLitsanProtocolText(value) {
    return normalizeProtocolWhitespace(unwrapCurrentUserRequestBlocks(stripMemoryContextBlocks(value)));
}
export function sanitizeLitsanProtocolValue(value) {
    if (typeof value === "string")
        return sanitizeLitsanProtocolText(value);
    if (Array.isArray(value))
        return value.map((item) => sanitizeLitsanProtocolValue(item));
    if (!value || typeof value !== "object")
        return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        output[key] = sanitizeLitsanProtocolValue(item);
    }
    return output;
}
export function stripMemoryContextBlocks(value) {
    let text = value;
    for (const tag of MEMORY_CONTEXT_TAGS) {
        text = replaceTaggedBlocks(text, tag, () => "", { removeUnclosedTail: true });
    }
    return text;
}
export function unwrapCurrentUserRequestBlocks(value) {
    return replaceTaggedBlocks(value, CURRENT_USER_REQUEST_TAG, (inner) => inner);
}
export function isLitsanRecallToolName(name) {
    return ["litsan_memory_search", "litsan_memory_get", "memmy_memory_search", "memmy_memory_get"].includes(name);
}
export function litsanRecallToolPlaceholder(name) {
    const toolName = isLitsanRecallToolName(name) ? String(name) : "litsan_memory";
    return `[litsan memory result omitted from capture: ${toolName}]`;
}
function replaceTaggedBlocks(value, tag, replace, options = {}) {
    let text = value;
    for (;;) {
        const openMatch = new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>`, "i").exec(text);
        if (!openMatch)
            return text;
        const openStart = openMatch.index;
        const openEnd = openStart + openMatch[0].length;
        const closeMatch = new RegExp(`</${escapeRegExp(tag)}>`, "i").exec(text.slice(openEnd));
        if (!closeMatch) {
            if (!options.removeUnclosedTail)
                return text;
            text = text.slice(0, openStart).trimEnd();
            continue;
        }
        const closeStart = openEnd + closeMatch.index;
        const closeEnd = closeStart + closeMatch[0].length;
        const inner = text.slice(openEnd, closeStart);
        text = `${text.slice(0, openStart)}${replace(inner, openMatch[0], closeMatch[0])}${text.slice(closeEnd)}`;
    }
}
function normalizeProtocolWhitespace(value) {
    return value
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
