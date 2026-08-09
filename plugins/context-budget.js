const DEFAULTS = {
  informThreshold: 90_000,
  warnThreshold: 110_000,
  handoffThreshold: 125_000,
  reserveOutputTokens: 16_000,
  estimateCharsPerToken: 4,
}

function formatTokens(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "unknown"
}

function estimateTokens(text, charsPerToken) {
  return text ? Math.ceil(String(text).length / charsPerToken) : 0
}

function findStepFinish(event) {
  const candidates = [event?.properties?.part, event?.properties?.message?.part, event?.part]
  return candidates.find((part) => part?.type === "step-finish" && part.tokens)
}

function levelFor(tokens, config) {
  if (tokens >= config.handoffThreshold) return "handoff"
  if (tokens >= config.warnThreshold) return "warn"
  if (tokens >= config.informThreshold) return "inform"
  return "ok"
}

function budgetNote(state, config) {
  const estimated = state.exactInput + state.pending
  const level = levelFor(estimated, config)
  const remaining = Number.isFinite(state.contextLimit)
    ? Math.max(state.contextLimit - estimated - config.reserveOutputTokens, 0)
    : undefined
  const heading = {
    inform: "CONTEXT BUDGET NOTICE",
    warn: "CONTEXT BUDGET WARNING",
    handoff: "CONTEXT BUDGET HANDOFF REQUIRED",
  }[level]
  const action = {
    inform: "Avoid unnecessary large reads and keep expensive investigation bounded.",
    warn: "Prefer concise tools and delegated summaries. Do not load large sources unless decision-critical.",
    handoff:
      "Stop broad work. Produce a compact handoff with current goal, files touched, decisions, verification status, risks, and exact next steps, then wait for a fresh session.",
  }[level]

  return [
    heading,
    `Model: ${state.providerID || "unknown"}/${state.modelID || "unknown"}`,
    `Last exact input: ${formatTokens(state.exactInput)} tokens`,
    `Estimated additions: ${formatTokens(state.pending)} tokens`,
    `Estimated current input: ${formatTokens(estimated)} tokens`,
    `Reserved output: ${formatTokens(config.reserveOutputTokens)} tokens`,
    `Estimated usable remaining: ${formatTokens(remaining)} tokens`,
    `Policy: ${action}`,
  ].join("\n")
}

export function createContextBudgetHooks(options = {}) {
  const config = { ...DEFAULTS, ...options }
  const sessions = new Map()

  function session(sessionID) {
    const existing = sessions.get(sessionID)
    if (existing) return existing

    const created = {
      exactInput: 0,
      pending: 0,
      contextLimit: undefined,
      modelID: undefined,
      providerID: undefined,
    }
    sessions.set(sessionID, created)
    return created
  }

  return {
    event: async ({ event }) => {
      const part = findStepFinish(event)
      if (!part) return
      const state = session(part.sessionID || event?.properties?.sessionID || "unknown")
      state.exactInput = Number(part.tokens.input) || 0
      state.pending = (Number(part.tokens.output) || 0) + (Number(part.tokens.reasoning) || 0)
    },

    "chat.message": async (input, output) => {
      const state = session(input.sessionID)
      const text = (output.parts || [])
        .filter((part) => part?.type === "text")
        .map((part) => part.text || "")
        .join("\n")
      state.pending += estimateTokens(text, config.estimateCharsPerToken)
      const level = levelFor(state.exactInput + state.pending, config)
      if (level !== "handoff") return
      output.message.system = [output.message.system, budgetNote(state, config)].filter(Boolean).join("\n\n")
    },

    "experimental.chat.system.transform": async (input, output) => {
      const state = session(input.sessionID)
      state.contextLimit = input.model?.limit?.context ?? state.contextLimit
      state.modelID = input.model?.id || input.model?.modelID || state.modelID
      state.providerID = input.model?.providerID || state.providerID
      const level = levelFor(state.exactInput + state.pending, config)
      if (level === "ok") return
      output.system.push(budgetNote(state, config))
    },

    "tool.execute.after": async (input, output) => {
      const state = session(input.sessionID)
      state.pending += estimateTokens(output.output, config.estimateCharsPerToken)
      const level = levelFor(state.exactInput + state.pending, config)
      if (level !== "warn" && level !== "handoff") return
      output.output = `${output.output}\n\n${budgetNote(state, config)}`
    },
  }
}

export default async () => createContextBudgetHooks()
