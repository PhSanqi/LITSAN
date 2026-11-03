# Passive recorders / 被动记录器

EN: Recorders run only when an existing harness invokes a hook/notify, or when you explicitly wrap a command. They never start an agent, daemon, scheduler, or model call. Hook recording has a total 3-second budget; failures emit a single-line stderr note and exit 0. A wrapped command keeps its own duration and exit code; recording overhead has the same budget.
简体中文：记录器只在现有 Harness 调用 hook/notify，或你主动包装命令时运行。它们不会启动代理、守护进程、调度器或模型调用。Hook 记录总预算为 3 秒；失败时向 stderr 输出单行说明并以 0 退出。包装命令保留自身运行时长和退出码，记录开销遵守相同预算。

EN: Configure cwd-to-project mapping in `~/.memmy/memhub/cli.json`. The longest matching directory prefix wins. Missing config or an unmapped cwd with `unmapped: "skip"` disables recording. `record_global` explicitly opts unmatched directories into global recording. `endpoint` overrides `LITSAN_TOOLS_URL`; the default is `http://127.0.0.1:3001/memhub/api/tools`. The shared CLI client currently accepts loopback HTTP only.
简体中文：在 `~/.memmy/memhub/cli.json` 配置工作目录到项目的映射，最长目录前缀优先。没有配置，或目录未匹配且 `unmapped: "skip"` 时不记录。`record_global` 明确允许未匹配目录进入全局记录。`endpoint` 优先于 `LITSAN_TOOLS_URL`，默认地址为 `http://127.0.0.1:3001/memhub/api/tools`。共用 CLI client 目前仅接受 loopback HTTP。

```json
{
  "projects": [{ "path": "/absolute/path/to/project", "project": "project-slug" }],
  "unmapped": "skip"
}
```

EN: On Windows use an absolute Windows path, such as `"C:\\work\\project"`. Directory matching uses the host platform's path rules. Git branch/default branch and linked-worktree hints come from local git commands with 500 ms timeouts. No git command contacts a remote.
简体中文：Windows 请使用绝对 Windows 路径，例如 `"C:\\work\\project"`。目录匹配遵循宿主平台的路径规则。分支、默认分支与链接 worktree 提示来自本地 git 命令，每个命令超时为 500 毫秒。任何 git 命令都不会访问远端。

## Claude Code / Claude Code

EN: Print the settings snippet, review it, then manually merge its `hooks` object into your Claude Code settings. The install command prints only; it never reads or writes harness settings.
简体中文：打印配置片段，检查后手动把 `hooks` 对象合并到 Claude Code 设置中。安装命令只打印，不会读取或写入 Harness 设置。

```sh
litsan hook install claude --print
```

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "litsan hook claude UserPromptSubmit", "timeout": 3 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "litsan hook claude Stop", "timeout": 3 }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "litsan hook claude SubagentStop", "timeout": 3 }] }]
  }
}
```

EN: User prompts open an L1 event immediately and inject its id as additional context. Stop commits the final assistant text and compact tool counts. Automation/delegated prompts are deferred: the shared recording policy records side effects or questions, links explicit child event ids, and skips short automation status replies without side effects. Skips are counted by UTC date. SubagentStop adds a parent summary, never a separate L1 event. An active Stop hook is ignored.
简体中文：用户提示立即打开 L1 事件，并把事件 id 注入上下文。Stop 提交最终助手文本与简洁的工具计数。自动化及委派提示延后处理：共用策略记录副作用或提问，链接明确的子事件 id，跳过无副作用的简短自动状态回复。跳过次数按 UTC 日期统计。SubagentStop 只追加父轮次摘要，不单独创建 L1 事件。已激活的 Stop hook 会被忽略。

EN: Harness `system-reminder` blocks are stripped before classification; recorded prompt text is capped at 20,000 characters. Task notifications, side-session events, CI events, wakeups, cross-session messages and delegated tasks preserve their source. Tags inside triple-backtick fences are treated as quoted user text.
简体中文：分类前移除 Harness 的 `system-reminder` 块，记录的提示文本最多 20,000 字符。任务通知、侧会话事件、CI 事件、唤醒、跨会话消息和委派任务保留对应来源。三反引号代码围栏中的标签视为用户引用文本。

## Codex notify / Codex 通知

EN: Print the notify configuration for manual setup. For a delegated call, enable notify per invocation and pass the delegator as `LITSAN_INITIATOR` JSON (`harness`, `session_id`, `event_id` are optional string fields). No command here edits Codex configuration.
简体中文：打印 notify 配置后手动设置。委派调用请逐次启用 notify，并用 `LITSAN_INITIATOR` JSON 传递发起方（`harness`、`session_id`、`event_id` 是可选字符串字段）。这里的命令不会编辑 Codex 配置。

```sh
litsan hook install codex --print
codex exec -c 'notify=["litsan","hook","codex"]' 'Your task'
```

EN: Only `agent-turn-complete` is recorded: joined input messages and the last assistant message, with `codex:<turn-id>` and `codex:<thread-id>`. With `LITSAN_INITIATOR` the source is agent/delegate; otherwise it is user/user_prompt.
简体中文：只记录 `agent-turn-complete`：合并的输入消息及最终助手消息，使用 `codex:<turn-id>` 与 `codex:<thread-id>`。有 `LITSAN_INITIATOR` 时来源为 agent/delegate，否则为 user/user_prompt。

## Command wrapper / 命令包装器

```sh
litsan run --harness agy --project project-slug -- agy-fixed --prompt 'Your task'
```

EN: The wrapper inherits stdin/stderr, tees stdout unchanged, and returns the child exit code. Prompt precedence is `-p=…`, `-p …` or `--prompt …` before `--prompt-file …`; without a prompt it skips recording. The assistant text is the last stdout line's JSON `response` string, or the final 20,000 stdout characters. The child receives `LITSAN_RECORDER=agy`. Delegator provenance comes from `LITSAN_INITIATOR`.
简体中文：包装器继承 stdin/stderr，原样透传 stdout，并返回子命令退出码。提示优先取 `-p=…`、`-p …` 或 `--prompt …`，其次取 `--prompt-file …`；没有提示则跳过记录。助手文本取 stdout 最后一行 JSON 的 `response` 字符串，否则取 stdout 最后 20,000 字符。子命令收到 `LITSAN_RECORDER=agy`。发起方信息来自 `LITSAN_INITIATOR`。

## One recorder, replay and disabling / 单记录者、重放与禁用

EN: Use exactly one recorder per session. With Claude hooks or Codex notify enabled, agents must not independently open/commit/record turns; Claude agents can checkpoint the injected event id. A wrapper announces itself through `LITSAN_RECORDER`. Harnesses without a recorder may continue agent-driven turn recording.
简体中文：每个会话只使用一个记录者。启用 Claude hook 或 Codex notify 后，代理不得独立 open/commit/record；Claude 代理可以用注入的事件 id 做 checkpoint。包装器通过 `LITSAN_RECORDER` 声明自身。没有记录器的 Harness 可继续由代理记录轮次。

EN: Non-timeout tool failures append to `spool.jsonl` in `~/.memmy/memhub/recorder/`. The client treats a timeout as sent with a pending response: it prints `sent; server response still pending` and does not enqueue a new retry. This message does not confirm server completion. Each invocation first replays up to 20 oldest entries; a replay timeout advances past that entry, while another failure stops the replay and retains the remaining entries. Install printing and active Stop are strictly inert exceptions. Stable event/turn ids make replay idempotent. State writes use atomic replacement. POSIX directories/files use 0700/0600; Windows protection follows the user's filesystem ACLs, since POSIX mode bits cannot set Windows ACLs.
简体中文：非超时的工具失败追加到 `~/.memmy/memhub/recorder/` 中的 `spool.jsonl`。客户端将超时视为已发送但响应未返回，输出 `sent; server response still pending`，不新增重试项；这条提示不代表服务端已完成。每次调用先按时间重放最多 20 条；重放遇到超时会移过该条目，其他失败则停止并保留剩余条目。安装打印与已激活的 Stop 是严格无操作的例外。稳定事件及轮次 id 确保重放幂等。状态文件通过原子替换写入。POSIX 目录/文件使用 0700/0600；Windows 的保护遵循用户文件系统 ACL，因为 POSIX 权限位不能设置 Windows ACL。

```sh
litsan hook flush
litsan hook status
```

EN: Status emits JSON with `spool_size` (entry count), daily `skipped` counts, `config_path` and `mapped_projects`. Tests must set both `LITSAN_RECORDER_HOME` and `LITSAN_CLI_CONFIG` to temporary paths. Windows runtime verification remains required before claiming dual-platform completion; the permission difference is a platform constraint, not a deliberate weaker privacy design.
简体中文：Status 输出 JSON，包含 `spool_size`（条目数）、每日 `skipped` 计数、`config_path` 与 `mapped_projects`。测试必须把 `LITSAN_RECORDER_HOME` 和 `LITSAN_CLI_CONFIG` 都设为临时路径。声称双平台完成前仍需 Windows 运行验证；权限差异是平台限制，不是有意降低隐私要求。

EN: Disable by removing the three Claude hook entries or the Codex notify setting, or by launching the command without `litsan run`. A missing mapping with `unmapped: "skip"` disables new recording for that cwd. Existing queued requests remain available for explicit or subsequent replay; do not delete pending evidence to disable recording.
简体中文：禁用时移除三个 Claude hook 条目或 Codex notify 设置，或不经 `litsan run` 直接运行命令。`unmapped: "skip"` 下未匹配的目录不会创建新记录。已排队的请求仍可手动或在后续调用中重放；不要为了禁用而删除待处理证据。
