import { readFile } from "node:fs/promises";
let runtimeAssetPromise = null;
export function loadLitsanWorkspaceBridgeRuntimeAsset() {
    runtimeAssetPromise ??= readFile(new URL("./litsan-workspace-bridge.mjs", import.meta.url), "utf8").then((content) => {
        if (!content.trim())
            throw new Error("LITSAN lifecycle sidecar asset is empty");
        return content;
    }).catch((error) => {
        runtimeAssetPromise = null;
        throw new Error(`LITSAN lifecycle sidecar asset is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
    return runtimeAssetPromise;
}
