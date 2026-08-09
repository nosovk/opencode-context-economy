import assert from "node:assert/strict"
import test from "node:test"

import { createContextBudgetHooks } from "../plugins/context-budget.js"

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

  await hooks["chat.message"]({ sessionID: "session-3" }, message)

  assert.match(message.message.system, /CONTEXT BUDGET HANDOFF REQUIRED/)
  assert.match(message.message.system, /Stop broad work/)
  assert.match(message.message.system, /current goal, files touched, decisions, verification status, risks, and exact next steps/)
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
