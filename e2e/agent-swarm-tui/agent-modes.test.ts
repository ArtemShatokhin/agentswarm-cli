import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  latestOpenAITestModel,
  openAIProviderTestConfig,
  startAgencyProtocolServer,
  startNativeLLMServer,
  startTui,
  startTuiDemoAgencyServer,
  type NativeLLMServer,
  type TuiProcess,
  type AgencyProtocolServer,
} from "./harness"
import {
  clearPrompt,
  footerHasMode,
  hasCommand,
  hasCompletedRunTurn,
  isNativeTitleRequest,
  nativeOpenAIOnlyConfig,
  nativeRequestBody,
  selectProductMode,
  tuiInteractionTimeoutMs,
  tuiNativeTurnTimeoutMs,
  tuiReadyTimeoutMs,
  waitForConfiguredDemoRecipient,
  waitForModelOption,
  waitForNativeLLMRequest,
} from "./terminal-tui.helpers"

let currentTui: TuiProcess | undefined
let currentServer: AgencyProtocolServer | undefined
let currentNativeServer: NativeLLMServer | undefined
const tempDirs: string[] = []

function hasTimelineRow(screen: string, prompt: string) {
  return screen.split("\n").some((line) => line.includes(prompt) && /\d{1,2}:\d{2}/.test(line))
}

async function waitForCommand(tui: TuiProcess, command: string) {
  await tui.waitFor(() => hasCommand(tui.screen(), command), `${command} command`, tuiInteractionTimeoutMs)
  return tui.screen()
}

function footerHasAgent(screen: string, agent: string) {
  const lines = screen.split("\n")
  return lines.some((line, index) => line.includes(`${agent} ·`) && (lines[index + 1] ?? "").includes("▀▀"))
}

function nativeOpenAIConfig(baseURL: string) {
  return {
    model: latestOpenAITestModel,
    enabled_providers: openAIProviderTestConfig.enabled_providers,
    provider: {
      openai: {
        options: {
          apiKey: "test-openai-key",
          baseURL,
        },
      },
    },
  }
}

async function findOpenCodeDatabase(dataHome: string) {
  const dir = path.join(dataHome, "agentswarm")
  const entries = await readdir(dir)
  const db = entries.find((entry) => /^opencode(?:-.+)?\.db$/.test(entry))
  if (!db) throw new Error(`No opencode database found in ${dir}`)
  return path.join(dir, db)
}

function stripAgencySwarmBridgeMetadata(dbPath: string) {
  const db = new Database(dbPath)
  try {
    let count = 0
    const rows = db.query<{ id: string; data: string }, []>("select id, data from part").all()
    const update = db.query("update part set data = ? where id = ?")
    for (const row of rows) {
      const data = JSON.parse(row.data) as { metadata?: Record<string, unknown> }
      if (data.metadata?.agencySwarmBridge === undefined) continue
      delete data.metadata.agencySwarmBridge
      if (Object.keys(data.metadata).length === 0) delete data.metadata
      update.run(JSON.stringify(data), row.id)
      count++
    }
    return count
  } finally {
    db.close()
  }
}

function seedSessionRevertForPrompt(dbPath: string, prompt: string) {
  const db = new Database(dbPath)
  try {
    const rows = db
      .query<
        { session_id: string; message_id: string; data: string },
        []
      >("select session_id, message_id, data from part order by id")
      .all()
    const row = rows.find((item) => {
      const data = JSON.parse(item.data) as { type?: string; text?: string; synthetic?: boolean; ignored?: boolean }
      return data.type === "text" && data.text === prompt && !data.synthetic && !data.ignored
    })
    if (!row) throw new Error(`No user text part found for ${prompt}`)
    db.query("update session set revert = ? where id = ?").run(
      JSON.stringify({ messageID: row.message_id }),
      row.session_id,
    )
    return row.message_id
  } finally {
    db.close()
  }
}
afterEach(async () => {
  await currentTui?.close()
  currentTui = undefined
  currentServer?.stop()
  currentServer = undefined
  currentNativeServer?.stop()
  currentNativeServer = undefined
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function waitForNextNativeLLMRequest(tui: TuiProcess, server: NativeLLMServer, start: number, label: string) {
  let request: NativeLLMServer["requests"][number] | undefined
  await tui.waitFor(
    () => {
      request = server.requests.slice(start).find((item) => !isNativeTitleRequest(item))
      return request !== undefined
    },
    label,
    tuiInteractionTimeoutMs,
  )
  return request!
}

async function waitForDeadAgencyServerUi(tui: TuiProcess) {
  await tui.waitFor(
    () => {
      const screen = tui.screen()
      return screen.includes("Connect to local agency-swarm server") || screen.includes("disconnected")
    },
    "dead Agency server reconnect UI",
    tuiInteractionTimeoutMs,
  )
  return tui.screen()
}

async function dismissAgencyConnectDialog(tui: TuiProcess) {
  if (!tui.screen().includes("Connect to local agency-swarm server")) return
  tui.write("\x1b")
  await tui.waitFor(
    () => !tui.screen().includes("Connect to local agency-swarm server"),
    "dismissed Agency connect dialog",
    tuiInteractionTimeoutMs,
  )
}
describe("Agent Swarm terminal TUI e2e", () => {
  test("/agents Build and Plan restore native command visibility", async () => {
    for (const mode of ["Build", "Plan"] as const) {
      currentServer = await startAgencyProtocolServer()
      currentTui = await startTui({ baseURL: currentServer.baseURL })

      await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
      await selectProductMode(currentTui, mode)
      currentTui.write("/rev")
      const screen = await waitForCommand(currentTui, "/review")

      expect(hasCommand(screen, "/review")).toBe(true)

      await currentTui.close()
      currentTui = undefined
      currentServer.stop()
      currentServer = undefined
    }
  })

  test("/agents Build and Plan stay native after a Run-mode Agency response", async () => {
    for (const mode of ["Build", "Plan"] as const) {
      currentServer = await startTuiDemoAgencyServer()
      currentNativeServer = await startNativeLLMServer()
      currentTui = await startTui({
        baseURL: currentServer.baseURL,
        agency: "tui-demo-agency",
        recipientAgent: "UserSupportAgent",
        configSource: "file",
        config: {
          model: latestOpenAITestModel,
          enabled_providers: openAIProviderTestConfig.enabled_providers,
          provider: {
            openai: {
              options: {
                apiKey: "test-openai-key",
                baseURL: currentNativeServer.baseURL,
              },
            },
          },
        },
      })

      await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
      currentTui.write(`run before ${mode.toLowerCase()} mode switch\r`)
      await currentTui.waitForText("TUI demo response complete.", tuiInteractionTimeoutMs)
      await currentTui.waitFor(
        () => currentServer!.requests.length === 1,
        `Run-mode Agency request before ${mode}`,
        tuiInteractionTimeoutMs,
      )
      const agencyRequests = currentServer.requests.length

      await selectProductMode(currentTui, mode)
      currentTui.write("who are you\r")
      await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)

      const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, "who are you")
      const body = JSON.stringify(request.body)
      expect(body).toContain("You are OpenCode")
      expect(body).toContain(mode === "Build" ? "Agent Swarm Build Instructions" : "Agent Swarm Planner Instructions")
      if (mode === "Plan") expect(body).toContain("plan_exit")
      expect(currentServer.requests).toHaveLength(agencyRequests)

      await currentTui.close()
      currentTui = undefined
      currentServer.stop()
      currentServer = undefined
      currentNativeServer.stop()
      currentNativeServer = undefined
    }
  })

  test("/agents Build and Plan stay native when launcher-style env config defaults to Run", async () => {
    for (const mode of ["Build", "Plan"] as const) {
      currentServer = await startTuiDemoAgencyServer()
      currentNativeServer = await startNativeLLMServer()
      currentTui = await startTui({
        baseURL: currentServer.baseURL,
        agency: "tui-demo-agency",
        recipientAgent: "UserSupportAgent",
        config: {
          model: latestOpenAITestModel,
          enabled_providers: openAIProviderTestConfig.enabled_providers,
          provider: {
            openai: {
              options: {
                apiKey: "test-openai-key",
                baseURL: currentNativeServer.baseURL,
              },
            },
          },
        },
      })

      await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
      await selectProductMode(currentTui, mode)
      currentTui.write(`who are you from ${mode.toLowerCase()} env config\r`)
      await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)

      await waitForNativeLLMRequest(
        currentTui,
        currentNativeServer,
        `who are you from ${mode.toLowerCase()} env config`,
      )
      const request = currentNativeServer.requests.find((item) =>
        JSON.stringify(item.body).includes(
          mode === "Build" ? "Agent Swarm Build Instructions" : "Agent Swarm Planner Instructions",
        ),
      )
      expect(request).toBeDefined()
      const body = JSON.stringify(request.body)
      expect(body).toContain(mode === "Build" ? "Agent Swarm Build Instructions" : "Agent Swarm Planner Instructions")
      if (mode === "Plan") expect(body).toContain("plan_exit")
      expect(currentServer.requests).toHaveLength(0)

      await currentTui.close()
      currentTui = undefined
      currentServer.stop()
      currentServer = undefined
      currentNativeServer.stop()
      currentNativeServer = undefined
    }
  })

  test("/agents Build and Plan work without an Agency server", async () => {
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      args: ["--model", latestOpenAITestModel],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(nativeOpenAIOnlyConfig(currentNativeServer.baseURL)),
      },
    })

    await currentTui.waitFor(() => footerHasMode(currentTui!.screen(), "Build"), "Build footer", tuiReadyTimeoutMs)

    for (const mode of ["Build", "Plan"] as const) {
      const prompt = `native no agency ${mode.toLowerCase()} prompt`
      await selectProductMode(currentTui, mode)
      currentTui.write(`${prompt}\r`)
      await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)

      const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, prompt)
      const body = JSON.stringify(request.body)
      expect(body).toContain("You are OpenCode")
      expect(body).toContain(mode === "Build" ? "Agent Swarm Build Instructions" : "Agent Swarm Planner Instructions")
      if (mode === "Plan") expect(body).toContain("plan_exit")
    }
  })

  test("/agents Build and Plan slash commands stay native when launcher-style env config defaults to Run", async () => {
    for (const mode of ["Build", "Plan"] as const) {
      const prompt = `agent-builder-command-route-${mode.toLowerCase()}`
      currentServer = await startTuiDemoAgencyServer()
      currentNativeServer = await startNativeLLMServer()
      currentTui = await startTui({
        baseURL: currentServer.baseURL,
        agency: "tui-demo-agency",
        recipientAgent: "UserSupportAgent",
        config: {
          model: latestOpenAITestModel,
          enabled_providers: openAIProviderTestConfig.enabled_providers,
          provider: {
            openai: {
              options: {
                apiKey: "test-openai-key",
                baseURL: currentNativeServer.baseURL,
              },
            },
          },
        },
      })

      await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
      await selectProductMode(currentTui, mode)
      currentTui.write(`/review ${prompt}\r`)
      await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)

      const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, prompt)
      const body = JSON.stringify(request.body)
      expect(body).toContain(prompt)
      expect(body).toContain("You are a code reviewer")
      expect(currentServer.requests).toHaveLength(0)

      await currentTui.close()
      currentTui = undefined
      currentServer.stop()
      currentServer = undefined
      currentNativeServer.stop()
      currentNativeServer = undefined
    }
  })

  test("native /agents selection updates Build and Plan routing", async () => {
    const prompt = "native agents picker selected plan"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      args: ["--model", "agency-swarm/default", "--agent", "build"],
      configSource: "file",
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    await selectProductMode(currentTui, "Build")
    await selectProductMode(currentTui, "Plan")

    currentTui.write(`${prompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, prompt)
    const body = JSON.stringify(request.body)
    expect(body).toContain("Agent Swarm Planner Instructions")
    expect(body).toContain("plan_exit")
    expect(body).not.toContain("Agent Swarm Build Instructions")
    expect(currentServer.requests).toHaveLength(0)
  })

  test("/agents preserves a selected native agent outside Run", async () => {
    const prompt = "native reviewer stays selected"
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      args: ["--agent", "reviewer"],
      configSource: "file",
      configContent: JSON.stringify({
        ...nativeOpenAIOnlyConfig(currentNativeServer.baseURL),
        agent: {
          reviewer: {
            mode: "primary",
            description: "Native reviewer",
            model: latestOpenAITestModel,
            prompt: "Native reviewer instructions.",
          },
        },
      }),
    })

    await currentTui.waitFor(
      () => footerHasAgent(currentTui!.screen(), "Reviewer"),
      "Reviewer footer",
      tuiReadyTimeoutMs,
    )
    currentTui.write("/agents\r")
    await currentTui.waitForText("Select agent", tuiInteractionTimeoutMs)
    const screen = await currentTui.waitForText("Reviewer", tuiInteractionTimeoutMs)
    expect(screen).toContain("Select agent")

    currentTui.write("\r")
    await currentTui.waitFor(
      () => !currentTui!.screen().includes("Select agent"),
      "native reviewer selection kept",
      tuiInteractionTimeoutMs,
    )
    expect(footerHasAgent(currentTui.screen(), "Reviewer")).toBe(true)

    currentTui.write(`${prompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, prompt)
    const body = JSON.stringify(request.body)
    expect(body).toContain("Native reviewer instructions.")
    expect(body).not.toContain("Agent Swarm Build Instructions")
  })

  test("Build task tool calls stay native when launcher-style env config defaults to Run", async () => {
    const parentPrompt = "call native task tool from build mode"
    const childPrompt = "child-task-routing-sentinel"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    await selectProductMode(currentTui, "Build")
    currentNativeServer.taskNext(childPrompt)
    currentTui.write(`${parentPrompt}\r`)

    await waitForNativeLLMRequest(currentTui, currentNativeServer, parentPrompt)
    const child = await waitForNativeLLMRequest(currentTui, currentNativeServer, childPrompt)
    expect(JSON.stringify(child.body)).toContain(childPrompt)
    expect(currentServer.requests).toHaveLength(0)
  })

  test("Plan handoff repeated arrow selection on Yes switches to Build", async () => {
    const planPrompt = "finish test plan with native plan_exit"
    const buildPrompt = "continue after approved native plan"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      config: nativeOpenAIConfig(currentNativeServer.baseURL),
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    await selectProductMode(currentTui, "Plan")
    await currentTui.waitFor(() => footerHasMode(currentTui!.screen(), "Plan"), "Plan footer", tuiInteractionTimeoutMs)

    currentNativeServer.planExitNext()
    currentTui.write(`${planPrompt}\r`)
    await currentTui.waitFor(
      () => currentTui!.screen().includes("Would you like") && currentTui!.screen().includes("switch to Build"),
      "Plan approval question",
      tuiInteractionTimeoutMs,
    )
    currentTui.write("\t")
    await Bun.sleep(100)
    expect(currentTui.screen()).toContain("switch to Build")
    expect(currentTui.screen()).not.toContain("Select agent")
    expect(footerHasMode(currentTui.screen(), "Build")).toBe(false)
    expect(currentServer.requests).toHaveLength(0)

    currentTui.write("\x1b[B\x1b[B\x1b[A\x1b[A")
    await Bun.sleep(100)
    expect(currentTui.screen()).toContain("Yes")
    expect(currentTui.screen()).toContain("switch to Build")

    currentTui.write("\r")
    await currentTui.waitFor(
      () => footerHasMode(currentTui!.screen(), "Build"),
      "Build footer after plan approval",
      tuiInteractionTimeoutMs,
    )
    expect(currentServer.requests).toHaveLength(0)

    const buildRequestStart = currentNativeServer.requests.length
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiNativeTurnTimeoutMs)
    const request = await waitForNextNativeLLMRequest(
      currentTui,
      currentNativeServer,
      buildRequestStart,
      "Build request after approved Plan handoff",
    )
    const body = JSON.stringify(request.body)
    expect(body).toContain("Agent Swarm Build Instructions")
    expect(body).not.toContain("Agent Swarm Planner Instructions")
    expect(currentServer.requests).toHaveLength(0)
  })

  test("Plan handoff arrow selection on No keeps Plan", async () => {
    const planPrompt = "decline test plan with native plan_exit"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      config: nativeOpenAIConfig(currentNativeServer.baseURL),
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    await selectProductMode(currentTui, "Plan")
    await currentTui.waitFor(() => footerHasMode(currentTui!.screen(), "Plan"), "Plan footer", tuiInteractionTimeoutMs)

    currentNativeServer.planExitNext()
    currentTui.write(`${planPrompt}\r`)
    await currentTui.waitFor(
      () => currentTui!.screen().includes("Would you like") && currentTui!.screen().includes("switch to Build"),
      "Plan approval question",
      tuiInteractionTimeoutMs,
    )
    currentTui.write("\x1b[B")
    await Bun.sleep(100)
    expect(currentTui.screen()).toContain("No")
    expect(currentTui.screen()).toContain("switch to Build")

    currentTui.write("\r")
    await currentTui.waitFor(
      () => !currentTui!.screen().includes("switch to Build") && footerHasMode(currentTui!.screen(), "Plan"),
      "Plan footer after declined plan approval",
      tuiInteractionTimeoutMs,
    )
    expect(currentServer.requests).toHaveLength(0)
    expect(footerHasMode(currentTui.screen(), "Build")).toBe(false)
  })

  test("startup Plan handoff recovers the pending approval question", async () => {
    const planPrompt = "startup plan prompt with native plan_exit"
    const buildPrompt = "continue after startup plan approval"
    currentNativeServer = await startNativeLLMServer()
    currentNativeServer.planExitNext()
    currentTui = await startTui({
      args: ["--model", latestOpenAITestModel, "--agent", "plan", "--prompt", planPrompt],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(nativeOpenAIOnlyConfig(currentNativeServer.baseURL)),
      },
    })

    await currentTui.waitFor(
      () => currentTui!.screen().includes("Would you like") && currentTui!.screen().includes("switch to Build"),
      "startup Plan approval question",
      tuiInteractionTimeoutMs,
    )
    expect(currentTui.screen()).toContain("plan_exit")
    expect(footerHasMode(currentTui.screen(), "Build")).toBe(false)

    currentTui.write("\r")
    await currentTui.waitFor(
      () => footerHasMode(currentTui!.screen(), "Build"),
      "Build footer after startup plan approval",
      tuiInteractionTimeoutMs,
    )

    const buildRequestStart = currentNativeServer.requests.length
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    const request = await waitForNextNativeLLMRequest(
      currentTui,
      currentNativeServer,
      buildRequestStart,
      "Build request after startup Plan approval",
    )
    const body = nativeRequestBody(request)
    expect(body).toContain("Agent Swarm Build Instructions")
    expect(body).not.toContain("Agent Swarm Planner Instructions")
  })

  test("/agents Build and Plan compact and follow-up stay native", async () => {
    for (const mode of ["Build", "Plan"] as const) {
      const prompt = `native compact setup ${mode.toLowerCase()}`
      const followUp = `native compact follow up ${mode.toLowerCase()}`
      currentServer = await startTuiDemoAgencyServer()
      currentNativeServer = await startNativeLLMServer()
      currentTui = await startTui({
        baseURL: currentServer.baseURL,
        agency: "tui-demo-agency",
        recipientAgent: "UserSupportAgent",
        configSource: "file",
        config: nativeOpenAIConfig(currentNativeServer.baseURL),
      })

      await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
      await selectProductMode(currentTui, mode)
      currentTui.write(`${prompt}\r`)
      await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
      await waitForNativeLLMRequest(currentTui, currentNativeServer, prompt)
      const requestCount = currentNativeServer.requests.length

      currentTui.write("/compact\r")
      let compact: NativeLLMServer["requests"][number] | undefined
      await currentTui.waitFor(
        () => {
          compact = currentNativeServer!.requests
            .slice(requestCount)
            .find((request) => !JSON.stringify(request.body).includes("title generator"))
          return compact !== undefined
        },
        `${mode} native compact request`,
        tuiInteractionTimeoutMs,
      )
      expect(JSON.stringify(compact!.body)).toContain("Summarize")
      expect(currentServer.requests).toHaveLength(0)

      currentTui.write(`${followUp}\r`)
      await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
      const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, followUp)
      const body = JSON.stringify(request.body)
      expect(body).toContain(mode === "Build" ? "Agent Swarm Build Instructions" : "Agent Swarm Planner Instructions")
      expect(currentServer.requests).toHaveLength(0)

      await currentTui.close()
      currentTui = undefined
      currentServer.stop()
      currentServer = undefined
      currentNativeServer.stop()
      currentNativeServer = undefined
    }
  })

  test("reopened Plan sessions keep Plan routing after switching away", async () => {
    const firstPlanPrompt = "first plan turn before reopening session"
    const buildPrompt = "build turn before reopening plan session"
    const secondPlanPrompt = "second plan turn after reopening session"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    await selectProductMode(currentTui, "Plan")
    currentTui.write(`${firstPlanPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    const first = await waitForNativeLLMRequest(currentTui, currentNativeServer, firstPlanPrompt)
    expect(JSON.stringify(first.body)).toContain("Agent Swarm Planner Instructions")

    currentTui.write("/new")
    await currentTui.waitFor(
      () => currentTui!.screen().includes("/new"),
      "visible /new command",
      tuiInteractionTimeoutMs,
    )
    currentTui.write("\r")
    await currentTui.waitFor(
      () => !currentTui!.screen().includes(firstPlanPrompt),
      "new empty prompt after leaving Plan session",
      tuiInteractionTimeoutMs,
    )

    await selectProductMode(currentTui, "Build")
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    const build = await waitForNativeLLMRequest(currentTui, currentNativeServer, buildPrompt)
    expect(JSON.stringify(build.body)).toContain("Agent Swarm Build Instructions")

    currentTui.write("/sessions\r")
    await currentTui.waitForText("Sessions", tuiInteractionTimeoutMs)
    currentTui.write("\x1b[B\r")
    await currentTui.waitForText(firstPlanPrompt, tuiInteractionTimeoutMs)
    await currentTui.waitFor(
      () => footerHasMode(currentTui!.screen(), "Plan"),
      "reopened Plan footer",
      tuiInteractionTimeoutMs,
    )
    currentTui.write("/models\r")
    await currentTui.waitForText("Select model", tuiInteractionTimeoutMs)
    currentTui.write("gpt-5.2")
    await waitForModelOption(currentTui, "GPT-5.2")
    currentTui.write("\r")
    await currentTui.waitFor(
      () => !currentTui!.screen().includes("Select model"),
      "Plan model selected",
      tuiInteractionTimeoutMs,
    )
    if (currentTui.screen().includes("Select variant")) {
      currentTui.write("\r")
      await currentTui.waitFor(
        () => !currentTui!.screen().includes("Select variant"),
        "Plan variant selected",
        tuiInteractionTimeoutMs,
      )
    }
    await currentTui.waitForText("Plan · GPT-5.2", tuiInteractionTimeoutMs)

    currentTui.write(`${secondPlanPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    const second = await waitForNativeLLMRequest(currentTui, currentNativeServer, secondPlanPrompt)
    const body = JSON.stringify(second.body)
    expect(second.body.model).toBe("gpt-5.2")
    expect(body).toContain("Agent Swarm Planner Instructions")
    expect(body).toContain("plan_exit")
    expect(body).not.toContain("Agent Swarm Build Instructions")
    expect(currentServer.requests).toHaveLength(0)
  })

  test("reopened Build and Plan shell-command sessions stay native", async () => {
    for (const mode of ["Build", "Plan"] as const) {
      const dataHome = await mkdtemp(path.join(os.tmpdir(), `agentswarm-shell-reopen-${mode.toLowerCase()}-`))
      const shellMarker = `shell-reopen-${mode.toLowerCase()}-marker`
      const prompt = `prompt after shell reopen ${mode.toLowerCase()}`
      tempDirs.push(dataHome)
      currentServer = await startTuiDemoAgencyServer()
      currentNativeServer = await startNativeLLMServer()
      currentTui = await startTui({
        baseURL: currentServer.baseURL,
        agency: "tui-demo-agency",
        recipientAgent: "UserSupportAgent",
        configSource: "file",
        env: {
          XDG_DATA_HOME: dataHome,
        },
        config: nativeOpenAIConfig(currentNativeServer.baseURL),
      })

      await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
      await selectProductMode(currentTui, mode)
      currentTui.write(`!printf ${shellMarker}\r`)
      await currentTui.waitForText(shellMarker, tuiInteractionTimeoutMs)
      currentTui.write("\x1b")
      await currentTui.waitFor(
        () => footerHasMode(currentTui!.screen(), mode) && !currentTui!.screen().includes("esc exit shell mode"),
        `${mode} shell command view closed`,
        tuiInteractionTimeoutMs,
      )
      clearPrompt(currentTui)
      currentTui.write("/sessions")
      await currentTui.waitForText("/sessions", tuiInteractionTimeoutMs)
      currentTui.write("\r")
      await currentTui.waitForText("Sessions", tuiInteractionTimeoutMs)
      await currentTui.waitForText(shellMarker, tuiInteractionTimeoutMs)
      currentTui.write("\x1b")
      await currentTui.waitFor(
        () => !currentTui!.screen().includes("Sessions"),
        "sessions dialog closed",
        tuiInteractionTimeoutMs,
      )
      expect(currentServer.requests).toHaveLength(0)
      await currentTui.close()
      currentTui = undefined

      currentTui = await startTui({
        baseURL: currentServer.baseURL,
        agency: "tui-demo-agency",
        recipientAgent: "UserSupportAgent",
        configSource: "file",
        env: {
          XDG_DATA_HOME: dataHome,
        },
        config: nativeOpenAIConfig(currentNativeServer.baseURL),
      })

      await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
      if (!currentTui.screen().includes(shellMarker)) {
        currentTui.write("/sessions\r")
        await currentTui.waitForText("Sessions", tuiInteractionTimeoutMs)
        currentTui.write("\r")
        await currentTui.waitForText(shellMarker, tuiInteractionTimeoutMs)
      }
      await currentTui.waitFor(
        () => footerHasMode(currentTui!.screen(), mode),
        `${mode} footer`,
        tuiInteractionTimeoutMs,
      )

      currentTui.write(`${prompt}\r`)
      await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
      const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, prompt)
      const body = JSON.stringify(request.body)
      expect(body).toContain(mode === "Build" ? "Agent Swarm Build Instructions" : "Agent Swarm Planner Instructions")
      expect(currentServer.requests).toHaveLength(0)

      await currentTui.close()
      currentTui = undefined
      currentServer.stop()
      currentServer = undefined
      currentNativeServer.stop()
      currentNativeServer = undefined
    }
  })

  test("Build repair can be verified by returning to Run", async () => {
    const buildPrompt = "repair changed swarm before run verification"
    const runPrompt = "verify repaired swarm after build"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    await selectProductMode(currentTui, "Build")
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)

    const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, buildPrompt)
    expect(JSON.stringify(request.body)).toContain("Agent Swarm Build Instructions")
    expect(currentServer.requests).toHaveLength(0)

    await selectProductMode(currentTui, "Run")
    await currentTui.waitForText("Swarm Default", tuiInteractionTimeoutMs)

    currentTui.write(`${runPrompt}\r`)
    await currentTui.waitFor(
      () => currentServer!.requests.some((request) => request.body.message === runPrompt),
      "Run request after native Build prompt",
      tuiInteractionTimeoutMs,
    )
    expect(currentServer.requests[0]?.body).toMatchObject({
      message: runPrompt,
      recipient_agent: "UserSupportAgent",
    })

    currentTui.write("/")
    const screen = await waitForCommand(currentTui, "/agents")
    expect(hasCommand(screen, "/agents")).toBe(true)
    expect(hasCommand(screen, "/review")).toBe(false)
  })

  test("Run failure can be fixed in Build and verified back in Run", async () => {
    const failedPrompt = "run broken swarm before build repair"
    const buildPrompt = "fix run failure in build mode"
    const runPrompt = "run fixed swarm after build repair"
    const repair = { done: false }
    currentServer = await startTuiDemoAgencyServer({ repair })
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    currentTui.write(`${failedPrompt}\r`)
    await currentTui.waitForText("Swarm code crashed before repair", tuiInteractionTimeoutMs)
    expect(currentServer.requests[0]?.body).toMatchObject({
      message: failedPrompt,
      recipient_agent: "UserSupportAgent",
    })

    await selectProductMode(currentTui, "Build")
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, buildPrompt)
    expect(JSON.stringify(request.body)).toContain("Agent Swarm Build Instructions")
    expect(currentServer.requests).toHaveLength(1)
    repair.done = true

    await selectProductMode(currentTui, "Run")
    currentTui.write(`${runPrompt}\r`)
    await currentTui.waitForText("TUI demo response complete.", tuiInteractionTimeoutMs)

    expect(currentServer.requests).toHaveLength(2)
    expect(currentServer.requests[1]?.body).toMatchObject({
      message: runPrompt,
      recipient_agent: "UserSupportAgent",
    })
  })

  test("dead Run server still allows Build repair without Agency requests", async () => {
    const buildPrompt = "fix swarm after dead server"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      config: nativeOpenAIConfig(currentNativeServer.baseURL),
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    await waitForConfiguredDemoRecipient(currentTui)

    const stoppedServer = currentServer
    stoppedServer.stop()
    currentServer = undefined

    const deadScreen = await waitForDeadAgencyServerUi(currentTui)
    expect(deadScreen.includes("Connect to local agency-swarm server") || deadScreen.includes("disconnected")).toBe(
      true,
    )
    await dismissAgencyConnectDialog(currentTui)

    await selectProductMode(currentTui, "Build")
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)

    const request = await waitForNativeLLMRequest(currentTui, currentNativeServer, buildPrompt)
    const body = JSON.stringify(request.body)
    expect(body).toContain("You are OpenCode")
    expect(body).toContain("Agent Swarm Build Instructions")
    expect(stoppedServer.requests).toHaveLength(0)
  })

  test("mixed Run and Build sessions keep per-turn labels stable", async () => {
    const runPrompt = "run before mixed mode label switch"
    const buildPrompt = "build after mixed mode label switch"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    currentTui.write(`${runPrompt}\r`)
    await currentTui.waitForText("TUI demo response complete.", tuiInteractionTimeoutMs)
    await currentTui.waitForText("Run ·", tuiInteractionTimeoutMs)

    await selectProductMode(currentTui, "Build")
    expect(currentTui.screen()).toContain("Run ·")
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    await waitForNativeLLMRequest(currentTui, currentNativeServer, buildPrompt)
    expect(currentTui.screen()).toContain("Build ·")

    await selectProductMode(currentTui, "Run")
    const screen = currentTui.screen()
    expect(screen).toContain("Run ·")
    expect(screen).toContain("Build ·")
    expect(currentServer.requests).toHaveLength(1)
  })

  test("/agents Build keeps undo hidden for a previous Run turn", async () => {
    const runPrompt = "run before undo mode switch"
    currentServer = await startTuiDemoAgencyServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    currentTui.write(`${runPrompt}\r`)
    await currentTui.waitForText("TUI demo response complete.", tuiInteractionTimeoutMs)
    await currentTui.waitForText("Run ·", tuiInteractionTimeoutMs)

    await selectProductMode(currentTui, "Build")
    currentTui.write("/und")
    await currentTui.waitForText("/und", tuiInteractionTimeoutMs)
    await Bun.sleep(100)
    expect(hasCommand(currentTui.screen(), "/undo")).toBe(false)
  })

  test("/agents Run keeps redo visible for a previous Build turn", async () => {
    const buildPrompt = "build before redo mode switch"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    await selectProductMode(currentTui, "Build")
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    await waitForNativeLLMRequest(currentTui, currentNativeServer, buildPrompt)

    currentTui.write("/undo\r")
    await currentTui.waitForText("message reverted", tuiInteractionTimeoutMs)
    await currentTui.waitForText("/redo to restore", tuiInteractionTimeoutMs)

    await selectProductMode(currentTui, "Run")
    await currentTui.waitForText("/redo to restore", tuiInteractionTimeoutMs)
    currentTui.write("/red")
    const screen = await waitForCommand(currentTui, "/redo")
    expect(hasCommand(screen, "/redo")).toBe(true)
  })

  test("/agents Run hides redo when the next reverted turn is Run", async () => {
    const buildPrompt = "build before hidden redo target"
    const runPrompt = "run after hidden redo target"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    await selectProductMode(currentTui, "Build")
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    await waitForNativeLLMRequest(currentTui, currentNativeServer, buildPrompt)

    await selectProductMode(currentTui, "Run")
    currentTui.write(`${runPrompt}\r`)
    await currentTui.waitForText("TUI demo response complete.", tuiInteractionTimeoutMs)
    await currentTui.waitFor(
      () => hasCompletedRunTurn(currentTui?.screen() ?? ""),
      "completed Run turn",
      tuiInteractionTimeoutMs,
    )

    currentTui.write("/timeline\r")
    await currentTui.waitForText("Timeline", tuiInteractionTimeoutMs)
    currentTui.write(buildPrompt)
    await currentTui.waitFor(
      () => hasTimelineRow(currentTui?.screen() ?? "", buildPrompt),
      "filtered Build timeline row",
      tuiInteractionTimeoutMs,
    )
    currentTui.write("\r")
    await currentTui.waitForText("Message Actions", tuiInteractionTimeoutMs)
    currentTui.write("\r")
    await currentTui.waitForText("message reverted", tuiInteractionTimeoutMs)
    await currentTui.waitFor(
      () => {
        const screen = currentTui?.screen() ?? ""
        return screen.includes("message reverted") && !screen.includes("/redo to restore")
      },
      "hidden Run redo banner",
      tuiInteractionTimeoutMs,
    )

    clearPrompt(currentTui)
    currentTui.write("/red")
    await currentTui.waitForText("/red", tuiInteractionTimeoutMs)
    await Bun.sleep(100)
    expect(hasCommand(currentTui.screen(), "/redo")).toBe(false)
  })

  test("/agents Run hides redo for a reverted final Run turn", async () => {
    const runPrompt = "final run hidden redo target"
    const dataHome = await mkdtemp(path.join(os.tmpdir(), "agentswarm-final-run-redo-data-"))
    tempDirs.push(dataHome)
    currentServer = await startTuiDemoAgencyServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      env: {
        XDG_DATA_HOME: dataHome,
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    currentTui.write(`${runPrompt}\r`)
    await currentTui.waitForText("TUI demo response complete.", tuiInteractionTimeoutMs)
    await currentTui.waitFor(
      () => hasCompletedRunTurn(currentTui?.screen() ?? ""),
      "completed Run turn",
      tuiInteractionTimeoutMs,
    )
    await currentTui.close()
    currentTui = undefined

    const messageID = seedSessionRevertForPrompt(await findOpenCodeDatabase(dataHome), runPrompt)
    expect(messageID.length).toBeGreaterThan(0)

    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      env: {
        XDG_DATA_HOME: dataHome,
      },
    })
    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    if (!currentTui.screen().includes("message reverted")) {
      currentTui.write("/sessions\r")
      await currentTui.waitForText("Sessions", tuiInteractionTimeoutMs)
      currentTui.write("\r")
    }
    await currentTui.waitForText("message reverted", tuiInteractionTimeoutMs)
    await currentTui.waitFor(
      () => {
        const screen = currentTui?.screen() ?? ""
        return screen.includes("message reverted") && !screen.includes("/redo to restore")
      },
      "hidden final Run redo banner",
      tuiInteractionTimeoutMs,
    )

    clearPrompt(currentTui)
    currentTui.write("/red")
    await currentTui.waitForText("/red", tuiInteractionTimeoutMs)
    await Bun.sleep(100)
    expect(hasCommand(currentTui.screen(), "/redo")).toBe(false)
  })

  test("/agents Run hides redo when the reverted turn is Run before later Build history", async () => {
    const runPrompt = "run before later build hidden redo"
    const buildPrompt = "build after reverted run hidden redo"
    const dataHome = await mkdtemp(path.join(os.tmpdir(), "agentswarm-run-before-build-redo-data-"))
    tempDirs.push(dataHome)
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      env: {
        XDG_DATA_HOME: dataHome,
      },
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    currentTui.write(`${runPrompt}\r`)
    await currentTui.waitForText("TUI demo response complete.", tuiInteractionTimeoutMs)
    await currentTui.waitFor(
      () => hasCompletedRunTurn(currentTui?.screen() ?? ""),
      "completed Run turn",
      tuiInteractionTimeoutMs,
    )

    await selectProductMode(currentTui, "Build")
    currentTui.write(`${buildPrompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    await waitForNativeLLMRequest(currentTui, currentNativeServer, buildPrompt)
    await currentTui.close()
    currentTui = undefined

    const messageID = seedSessionRevertForPrompt(await findOpenCodeDatabase(dataHome), runPrompt)
    expect(messageID.length).toBeGreaterThan(0)

    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      env: {
        XDG_DATA_HOME: dataHome,
      },
      config: {
        model: latestOpenAITestModel,
        enabled_providers: openAIProviderTestConfig.enabled_providers,
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })
    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    if (!currentTui.screen().includes("message reverted")) {
      currentTui.write("/sessions\r")
      await currentTui.waitForText("Sessions", tuiInteractionTimeoutMs)
      currentTui.write("\r")
    }
    await currentTui.waitForText("message reverted", tuiInteractionTimeoutMs)
    await currentTui.waitFor(
      () => {
        const screen = currentTui?.screen() ?? ""
        return screen.includes("message reverted") && !screen.includes("/redo to restore")
      },
      "hidden reverted Run redo banner before later Build history",
      tuiInteractionTimeoutMs,
    )

    clearPrompt(currentTui)
    currentTui.write("/red")
    await currentTui.waitForText("/red", tuiInteractionTimeoutMs)
    await Bun.sleep(100)
    expect(hasCommand(currentTui.screen(), "/redo")).toBe(false)
  })

  test("legacy Run sessions without bridge metadata keep Run labels after mode switch", async () => {
    const runPrompt = "legacy run before bridge metadata"
    const dataHome = await mkdtemp(path.join(os.tmpdir(), "agentswarm-legacy-mode-data-"))
    tempDirs.push(dataHome)
    currentServer = await startTuiDemoAgencyServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      env: {
        XDG_DATA_HOME: dataHome,
      },
    })

    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    currentTui.write(`${runPrompt}\r`)
    await currentTui.waitForText("TUI demo response complete.", tuiInteractionTimeoutMs)
    await currentTui.waitForText("Run ·", tuiInteractionTimeoutMs)
    await currentTui.close()
    currentTui = undefined

    const removed = stripAgencySwarmBridgeMetadata(await findOpenCodeDatabase(dataHome))
    expect(removed).toBeGreaterThan(0)

    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      env: {
        XDG_DATA_HOME: dataHome,
      },
    })
    await currentTui.waitForText("Swarm Default", tuiReadyTimeoutMs)
    if (!currentTui.screen().includes(runPrompt)) {
      currentTui.write("/sessions\r")
      await currentTui.waitForText("Sessions", tuiInteractionTimeoutMs)
      currentTui.write("\r")
      await currentTui.waitForText(runPrompt, tuiInteractionTimeoutMs)
    }

    await selectProductMode(currentTui, "Build")
    await currentTui.waitFor(() => currentTui!.screen().includes("Build ·"), "Build footer", tuiInteractionTimeoutMs)
    const screen = currentTui.screen()
    expect(screen).toContain(runPrompt)
    expect(screen).toContain("Run ·")
    expect(currentServer.requests).toHaveLength(1)
  })

  test("/agents Run selection stays native when Agency Swarm provider is excluded", async () => {
    const prompt = "prompt after excluded run selection"
    currentServer = await startTuiDemoAgencyServer()
    currentNativeServer = await startNativeLLMServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
      config: {
        enabled_providers: ["openai"],
        provider: {
          openai: {
            options: {
              apiKey: "test-openai-key",
              baseURL: currentNativeServer.baseURL,
            },
          },
        },
      },
    })

    await currentTui.waitFor(() => footerHasMode(currentTui!.screen(), "Build"), "Build footer", tuiReadyTimeoutMs)
    currentTui.write("/models\r")
    await currentTui.waitForText("Select model", tuiInteractionTimeoutMs)
    currentTui.write("gpt-5.2")
    await waitForModelOption(currentTui, "GPT-5.2")
    currentTui.write("\r")
    await currentTui.waitFor(
      () => !currentTui!.screen().includes("Select model"),
      "native model selected with Agency Swarm excluded",
      tuiInteractionTimeoutMs,
    )
    if (currentTui.screen().includes("Select variant")) {
      currentTui.write("\r")
      await currentTui.waitFor(
        () => !currentTui!.screen().includes("Select variant"),
        "variant selected with Agency Swarm excluded",
        tuiInteractionTimeoutMs,
      )
    }
    await currentTui.waitForText("Build · GPT-5.2", tuiInteractionTimeoutMs)

    await selectProductMode(currentTui, "Run")
    await currentTui.waitForText("Model agency-swarm/default is not valid", tuiInteractionTimeoutMs)
    expect(footerHasMode(currentTui.screen(), "Run")).toBe(false)
    expect(footerHasMode(currentTui.screen(), "Build")).toBe(true)

    currentTui.write(`${prompt}\r`)
    await currentTui.waitForText("native-mode-ok", tuiInteractionTimeoutMs)
    await waitForNativeLLMRequest(currentTui, currentNativeServer, prompt)
    expect(currentServer.requests).toHaveLength(0)
  })

  test("Tab toggles Build/Plan and switches swarm agents in Run", async () => {
    currentServer = await startTuiDemoAgencyServer()
    currentTui = await startTui({
      baseURL: currentServer.baseURL,
      agency: "tui-demo-agency",
      recipientAgent: "UserSupportAgent",
      configSource: "file",
    })

    await currentTui.waitForText("UserSupportAgent", tuiReadyTimeoutMs)
    await selectProductMode(currentTui, "Build")
    currentTui.write("\t")
    await currentTui.waitFor(
      () => footerHasMode(currentTui!.screen(), "Plan"),
      "Plan mode after Tab from Build",
      tuiInteractionTimeoutMs,
    )
    currentTui.write("\t")
    await currentTui.waitFor(
      () => footerHasMode(currentTui!.screen(), "Build"),
      "Build mode after Tab from Plan",
      tuiInteractionTimeoutMs,
    )

    await selectProductMode(currentTui, "Run")
    await currentTui.waitFor(
      () => footerHasAgent(currentTui!.screen(), "UserSupportAgent"),
      "Run footer before target Tab",
      tuiInteractionTimeoutMs,
    )
    currentTui.write("\t")
    await currentTui.waitFor(
      () => footerHasAgent(currentTui!.screen(), "MathAgent"),
      "MathAgent footer after Run target Tab",
      tuiInteractionTimeoutMs,
    )
    currentTui.write("tab-selected run target\r")
    await currentTui.waitFor(
      () => currentServer!.requests.length === 1,
      "Run agent target request",
      tuiInteractionTimeoutMs,
    )
    expect(currentServer.requests[0]?.body).toMatchObject({
      message: "tab-selected run target",
      recipient_agent: "MathAgent",
    })
  })
})
