import assert from "node:assert/strict"
import test from "node:test"

import { createContextBudgetHooks, createSessionRollover } from "../plugins/context-budget.js"

function makeHooks(options = {}) {
  return createContextBudgetHooks({
    informThreshold: 90_000,
    warnThreshold: 110_000,
    handoffThreshold: 125_000,
    reserveOutputTokens: 16_000,
    estimateCharsPerToken: 4,
    ...options,
  })
}

test("anchors the budget to provider-reported input tokens", async () => {
  const hooks = makeHooks()

  await hooks.event({
    event: {
      properties: {
        part: {
          type: "step-finish",
          sessionID: "session-1",
          tokens: { input: 91_000, output: 500, reasoning: 100 },
        },
      },
    },
  })

  const output = { system: [] }
  await hooks["experimental.chat.system.transform"](
    { sessionID: "session-1", model: { id: "model", providerID: "provider", limit: { context: 200_000 } } },
    output,
  )

  assert.equal(output.system.length, 1)
  assert.match(output.system[0], /CONTEXT BUDGET NOTICE/)
  assert.match(output.system[0], /91,600/)
})

test("estimates tool output added after the last exact count", async () => {
  const hooks = makeHooks({ warnThreshold: 100, informThreshold: 50, handoffThreshold: 200 })
  const output = { output: "x".repeat(404) }

  await hooks["tool.execute.after"]({ sessionID: "session-2", tool: "read" }, output)

  assert.match(output.output, /CONTEXT BUDGET WARNING/)
  assert.match(output.output, /101/)
})

test("requires a bounded handoff after the handoff threshold", async () => {
  const hooks = makeHooks({ informThreshold: 10, warnThreshold: 20, handoffThreshold: 30 })
  const message = { parts: [{ type: "text", text: "x".repeat(124) }], message: {} }
  const system = { system: [] }

  await hooks["chat.message"]({ sessionID: "session-3" }, message)
  await hooks["experimental.chat.system.transform"](
    { sessionID: "session-3", model: { id: "model", providerID: "provider" } },
    system,
  )

  assert.equal(message.message.system, undefined)
  assert.equal(system.system.length, 1)
  assert.match(system.system[0], /CONTEXT BUDGET HANDOFF REQUIRED/)
  assert.match(system.system[0], /Stop broad work/)
  assert.match(system.system[0], /current goal, files touched, decisions, verification status, risks, and exact next steps/)
})

test("does not inject routine notes below the notice threshold", async () => {
  const hooks = makeHooks()
  const output = { system: [] }

  await hooks["experimental.chat.system.transform"](
    { sessionID: "session-4", model: { limit: { context: 200_000 } } },
    output,
  )

  assert.deepEqual(output.system, [])
})

test("rolls an exhausted idle session over only once", async () => {
  const rollovers = []
  const hooks = createContextBudgetHooks(
    { informThreshold: 10, warnThreshold: 20, handoffThreshold: 30 },
    { rollover: async (input) => rollovers.push(input) },
  )
  const message = { parts: [{ type: "text", text: "x".repeat(124) }], message: {} }

  await hooks["chat.message"](
    {
      sessionID: "session-5",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    },
    message,
  )
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-5" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-5" } } })

  assert.deepEqual(rollovers, [
    {
      sessionID: "session-5",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    },
  ])
})

test("rolls over on session.status idle event", async () => {
  const rollovers = []
  const hooks = createContextBudgetHooks(
    { informThreshold: 10, warnThreshold: 20, handoffThreshold: 30 },
    { rollover: async (input) => rollovers.push(input) },
  )
  const message = { parts: [{ type: "text", text: "x".repeat(124) }], message: {} }

  await hooks["chat.message"](
    {
      sessionID: "session-status-idle",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    },
    message,
  )
  await hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-status-idle", status: { type: "idle" } },
    },
  })

  assert.deepEqual(rollovers, [
    {
      sessionID: "session-status-idle",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    },
  ])
})

test("requests rollover when a step finish crosses the handoff threshold", async () => {
  const rollovers = []
  const hooks = createContextBudgetHooks(
    { informThreshold: 10, warnThreshold: 20, handoffThreshold: 30 },
    { rollover: async (input) => rollovers.push(input) },
  )

  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "session-step-finish",
          tokens: { input: 31, output: 0, reasoning: 0 },
        },
      },
    },
  })

  const output = { system: [] }
  await hooks["experimental.chat.system.transform"](
    {
      sessionID: "session-step-finish",
      model: { id: "model", providerID: "provider", limit: { context: 200_000 } },
    },
    output,
  )
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "session-step-finish" } },
  })

  assert.match(output.system[0], /CONTEXT BUDGET HANDOFF REQUIRED/)
  assert.deepEqual(rollovers, [
    {
      sessionID: "session-step-finish",
      agent: undefined,
      model: { providerID: "provider", modelID: "model" },
    },
  ])
})

test("retries rollover after the previous handoff extraction failed", async () => {
  let attempts = 0
  const hooks = createContextBudgetHooks(
    { informThreshold: 10, warnThreshold: 20, handoffThreshold: 30 },
    {
      rollover: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("The plugin requested a structured HANDOFF block from the exhausted session")
      },
    },
  )

  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "session-retry",
          tokens: { input: 31, output: 0, reasoning: 0 },
        },
      },
    },
  })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-retry" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-retry" } } })

  assert.equal(attempts, 2)
})

test("creates a root continuation session in the source worktree", async () => {
  const calls = []
  const worktree = "/repo/.worktrees/feature-a"
  const client = {
    session: {
      get: async (input) => {
        calls.push(["get", input])
        return { data: { id: "old-session", directory: "/home/user", title: "Implement feature" } }
      },
      messages: async (input) => {
        calls.push(["messages", input])
        return {
          data: [
            {
              info: { id: "assistant-1", role: "assistant" },
              parts: [
                {
                  type: "text",
                  text: `Work completed before rollover.\n\n# HANDOFF\nWorktree: ${worktree}\nGoal: finish feature\nNext steps: run tests`,
                },
              ],
            },
          ],
        }
      },
      create: async (input) => {
        calls.push(["create", input])
        return { data: { id: "new-session", directory: worktree } }
      },
      promptAsync: async (input) => {
        calls.push(["prompt", input])
        return { data: undefined }
      },
    },
    tui: {
      selectSession: async (input) => {
        calls.push(["select", input])
        return { data: true }
      },
    },
  }

  const rollover = createSessionRollover(client, "/wrong-directory")
  await rollover({
    sessionID: "old-session",
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
  })

  assert.deepEqual(calls[2], [
    "create",
    { directory: worktree, title: "Implement feature (handoff)" },
  ])
  assert.deepEqual(calls[3], [
    "prompt",
    {
      sessionID: "new-session",
      directory: worktree,
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      parts: [
        {
          type: "text",
          text: [
            "Continue the existing task from the handoff below.",
            `Before making changes, verify that the active working directory is ${worktree} and inspect the current worktree state.`,
            "Do not look for or reconstruct the previous conversation. Treat this handoff and the current filesystem as the complete source of context.",
            "",
            "# HANDOFF",
            `Worktree: ${worktree}`,
            "Goal: finish feature",
            "Next steps: run tests",
          ].join("\n"),
        },
      ],
    },
  ])
  assert.deepEqual(calls[4], ["select", { sessionID: "new-session", directory: worktree }])
  assert.equal("parentID" in calls[2][1], false)
  assert.doesNotMatch(calls[3][1].parts[0].text, /Work completed before rollover/)
})

test("requests handoff block on first attempt without handoff, falls back on second", async () => {
  let created = false
  const prompts = []
  const client = {
    session: {
      get: async () => ({ data: { id: "old-session", directory: "/repo/worktree", title: "Task" } }),
      messages: async () => ({
        data: [
          {
            info: { id: "assistant-1", role: "assistant" },
            parts: [{ type: "text", text: "I stopped without producing the requested block." }],
          },
        ],
      }),
      create: async (input) => {
        created = true
        return { data: { id: "new-session", directory: input.directory } }
      },
      promptAsync: async (input) => {
        prompts.push(input)
        return { data: undefined }
      },
    },
    tui: {
      selectSession: async () => ({ data: true }),
    },
  }

  const rollover = createSessionRollover(client, "/repo/worktree")

  // First call prompts old session and throws intentional error
  await assert.rejects(
    rollover({ sessionID: "old-session", agent: "build" }),
    /requested a structured HANDOFF block/,
  )
  assert.equal(created, false)
  assert.equal(prompts.length, 1)

  // Second call (model still didn't write handoff) uses fallback handoff and creates session
  await rollover({ sessionID: "old-session", agent: "build" })
  assert.equal(created, true)
  assert.equal(prompts.length, 2)
  assert.match(prompts[1].parts[0].text, /Fallback handoff/i)
})

test("keeps the source session selected when continuation startup fails", async () => {
  let selected = false
  const client = {
    session: {
      get: async () => ({ data: { id: "old-session", directory: "/repo/worktree", title: "Task" } }),
      messages: async () => ({
        data: [
          {
            info: { id: "assistant-1", role: "assistant" },
            parts: [{ type: "text", text: "# HANDOFF\nGoal: continue safely" }],
          },
        ],
      }),
      create: async () => ({ data: { id: "new-session", directory: "/repo/worktree" } }),
      promptAsync: async () => ({ error: { message: "provider unavailable" } }),
    },
    tui: {
      selectSession: async () => {
        selected = true
      },
    },
  }

  const rollover = createSessionRollover(client, "/repo/worktree")

  await assert.rejects(
    rollover({ sessionID: "old-session", agent: "build" }),
    /Starting continuation session failed/,
  )
  assert.equal(selected, false)
})
