import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import path from "node:path"

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

function responseData(response, operation) {
  if (response?.error) throw new Error(`${operation} failed: ${JSON.stringify(response.error)}`)
  return response?.data ?? response
}

function extractHandoff(messages) {
  for (const message of [...(messages || [])].reverse()) {
    if (message?.info?.role !== "assistant") continue
    const text = (message.parts || [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text || "")
      .join("\n")
    const match =
      text.match(/(?:^|\n)(#{1,4}\s*(?:CONTEXT\s+)?HANDOFF\b[^\n]*[\s\S]*)$/i) ||
      text.match(/(?:^|\n)(\*{2,3}\s*(?:CONTEXT\s+)?HANDOFF\b[^\n]*\*{2,3}[\s\S]*)$/i)
    if (match) return match[1].trim()
  }
  return null
}

function fallbackHandoff(messages, fallbackDirectory) {
  const lastAssistantMessage = [...(messages || [])]
    .reverse()
    .find((m) => m?.info?.role === "assistant")
  const text = (lastAssistantMessage?.parts || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("\n")
    .trim()
  const snippet = text ? text.slice(-1000) : "No prior response text recorded."

  return [
    "# HANDOFF",
    `Worktree: ${fallbackDirectory}`,
    "Goal: Continue task following automatic session rollover.",
    "Verification status: Automatic fallback handoff generated after context exhaustion.",
    "Risks: Previous session reached context budget limit without explicit handoff block.",
    "Next steps: Verify working directory state and git status before continuing.",
    "",
    "## Last Assistant Snippet",
    snippet,
  ].join("\n")
}

function handoffDirectory(handoff, fallback) {
  const match = handoff.match(/^Worktree:\s*(.+)$/im)
  const directory = match?.[1]?.trim()
  return directory && path.isAbsolute(directory) ? path.normalize(directory) : fallback
}

export function createSessionRollover(client, fallbackDirectory) {
  const promptedSessions = new Set()

  return async ({ sessionID, agent, model }) => {
    let source
    let directory = fallbackDirectory
    try {
      source = responseData(
        await client.session.get({ sessionID, directory: fallbackDirectory }),
        "Reading source session",
      )
      directory = source.directory || fallbackDirectory
    } catch (err) {
      console.warn(`[context-budget] Could not read source session ${sessionID}, using fallback directory ${fallbackDirectory}:`, err.message || err)
    }

    let messages = []
    try {
      messages = responseData(
        await client.session.messages({ sessionID, directory }),
        "Reading source messages",
      )
    } catch (err) {
      console.warn(`[context-budget] Could not read source messages for ${sessionID}:`, err.message || err)
    }

    let handoff = extractHandoff(messages)

    if (!handoff) {
      if (!promptedSessions.has(sessionID)) {
        promptedSessions.add(sessionID)
        try {
          responseData(
            await client.session.promptAsync({
              sessionID,
              directory,
              ...(agent ? { agent } : {}),
              ...(model ? { model } : {}),
              parts: [
                {
                  type: "text",
                  text: "Stop all implementation work. Respond with only a '# HANDOFF' section containing the current goal, active worktree, files touched, decisions, verification status, risks, and exact next steps.",
                },
              ],
            }),
            "Requesting structured handoff",
          )
          throw new Error("The plugin requested a structured HANDOFF block from the exhausted session")
        } catch (err) {
          if (err.message?.includes("requested a structured HANDOFF block")) {
            throw err
          }
          // If promptAsync failed (e.g. context window exceeded), proceed with fallback handoff
        }
      }
      handoff = fallbackHandoff(messages, directory)
    }

    directory = handoffDirectory(handoff, directory)
    const created = responseData(
      await client.session.create({
        directory,
        title: `${source?.title || "Continued task"} (handoff)`,
      }),
      "Creating continuation session",
    )
    const continuation = [
      "Continue the existing task from the handoff below.",
      `Before making changes, verify that the active working directory is ${directory} and inspect the current worktree state.`,
      "Do not look for or reconstruct the previous conversation. Treat this handoff and the current filesystem as the complete source of context.",
      "",
      handoff,
    ].join("\n")

    responseData(
      await client.session.promptAsync({
        sessionID: created.id,
        directory,
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        parts: [{ type: "text", text: continuation }],
      }),
      "Starting continuation session",
    )

    try {
      responseData(
        await client.tui.selectSession({ sessionID: created.id, directory }),
        "Selecting continuation session",
      )
    } catch {
      // Non-fatal if tui.selectSession fails in headless or non-TUI environments
    }
  }
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
      "Stop broad work. Finish this response with a '# HANDOFF' section containing the current goal, files touched, decisions, verification status, risks, and exact next steps, plus the active worktree. Do not continue implementation after that section; the plugin will start a fresh session automatically.",
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

export function createContextBudgetHooks(options = {}, dependencies = {}) {
  const config = { ...DEFAULTS, ...options }
  const rollover = dependencies.rollover
  const sessions = new Map()

  function session(sessionID) {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, {
        exactInput: 0,
        pending: 0,
        contextLimit: undefined,
        modelID: undefined,
        providerID: undefined,
        agent: undefined,
        requestedRollover: false,
        startedRollover: false,
      })
    }
    return sessions.get(sessionID)
  }

  return {
    event: async ({ event }) => {
      const part = findStepFinish(event)
      if (part) {
        const state = session(part.sessionID || event?.properties?.sessionID || "unknown")
        state.exactInput = Number(part.tokens.input) || 0
        state.pending = (Number(part.tokens.output) || 0) + (Number(part.tokens.reasoning) || 0)
        if (levelFor(state.exactInput + state.pending, config) === "handoff") {
          state.requestedRollover = true
        }
      }

      const isIdle =
        event?.type === "session.idle" ||
        (event?.type === "session.status" && event.properties?.status?.type === "idle")
      if (!isIdle || !rollover) return
      const sessionID = event.properties?.sessionID
      const state = session(sessionID)
      if (!state.requestedRollover || state.startedRollover) return
      state.startedRollover = true
      try {
        await rollover({
          sessionID,
          agent: state.agent,
          model:
            state.providerID && state.modelID
              ? { providerID: state.providerID, modelID: state.modelID }
              : undefined,
        })
      } catch (error) {
        state.startedRollover = false
        if (!error.message?.includes("requested a structured HANDOFF block")) {
          console.error(`[context-budget] automatic handoff failed for ${sessionID}:`, error)
        }
      }
    },

    "chat.message": async (input, output) => {
      const state = session(input.sessionID)
      state.agent = input.agent || state.agent
      state.providerID = input.model?.providerID || state.providerID
      state.modelID = input.model?.modelID || state.modelID
      const text = (output.parts || [])
        .filter((part) => part?.type === "text")
        .map((part) => part.text || "")
        .join("\n")
      state.pending += estimateTokens(text, config.estimateCharsPerToken)
      const level = levelFor(state.exactInput + state.pending, config)
      if (level !== "handoff") return
      state.requestedRollover = true
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
      if (level === "handoff") state.requestedRollover = true
      if (level !== "warn" && level !== "handoff") return
      output.output = `${output.output}\n\n${budgetNote(state, config)}`
    },
  }
}

export default async ({ serverUrl, directory }) => {
  const client = createOpencodeClient({ baseUrl: serverUrl.toString(), directory })
  return createContextBudgetHooks({}, { rollover: createSessionRollover(client, directory) })
}
