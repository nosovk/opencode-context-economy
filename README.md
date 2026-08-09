# OpenCode Context Economy

An OpenCode context-budget governor plus a bounded public-research workflow.

## Included

- `plugins/context-budget.js` tracks provider-reported input tokens, estimates additions from messages and tool output, and injects escalating context-budget guidance.
- `skills/research-economy/SKILL.md` keeps broad retrieval out of the main context and sets confidentiality, response-size, and stopping rules.
- `agents/research-economy.md` defines a read-only public-source research subagent with a 600-token response cap.

## Install

Copy the components into OpenCode's global configuration:

```bash
git clone https://github.com/nosovk/opencode-context-economy.git
cd opencode-context-economy
mkdir -p ~/.config/opencode/plugins ~/.config/opencode/skills/research-economy ~/.config/opencode/agents
cp plugins/context-budget.js ~/.config/opencode/plugins/context-budget.js
cp skills/research-economy/SKILL.md ~/.config/opencode/skills/research-economy/SKILL.md
cp agents/research-economy.md ~/.config/opencode/agents/research-economy.md
```

The plugin, skill, and agent are auto-discovered from those directories. Quit and restart OpenCode after installation because config-time files are not hot-reloaded.

## Research Model

The included agent is pinned to:

```text
ai-gate/gemini-3.5-flash-extra-low
```

Your OpenCode provider configuration must expose that model, or you must change the `model` field in `agents/research-economy.md` to a low-cost model available in your setup.

## Context Thresholds

The plugin defaults are:

| Level | Estimated input tokens |
|---|---:|
| Notice | 90,000 |
| Warning | 110,000 |
| Handoff required | 125,000 |
| Reserved output | 16,000 |

The estimate is intentionally conservative: it anchors to each provider-reported `step-finish` input count, then adds estimated message and tool-output tokens until the next exact count.

## Test

Requires Node.js 20 or newer.

```bash
npm test
```

## License

MIT
