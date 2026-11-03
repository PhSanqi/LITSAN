export const LITSAN_SKILL_DIRECTORY_NAME = "litsan-memory";
export function renderLitsanSkillDirectoryFiles(manifest) {
    return [
        {
            relativePath: "SKILL.md",
            content: [
                "---",
                "name: litsan-memory",
                "description: Use shared LITSAN memory when prior context may be relevant.",
                "---",
                "",
                manifest.content.trimEnd(),
                ""
            ].join("\n")
        }
    ];
}
export function renderLitsanSkillBootstrapManifest(manifest) {
    return {
        ...manifest,
        content: [
            "# LITSAN Memory",
            "",
            "The `litsan-memory` skill is installed at `skills/litsan-memory/SKILL.md`.",
            "Use that skill when prior memory may be relevant to the current request."
        ].join("\n")
    };
}
