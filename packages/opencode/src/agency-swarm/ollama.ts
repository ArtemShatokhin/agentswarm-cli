import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { Log } from "@/util"

export namespace AgencySwarmOllama {
  const log = Log.create({ service: "agency-swarm.ollama" })
  const tagsURL = "http://127.0.0.1:11434/api/tags"
  const pullURL = "http://127.0.0.1:11434/api/pull"
  const started = new Set<ChildProcess>()
  const ownedListenerPids = new Set<number>()
  let handlers = false

  export const PROVIDER_ID = "ollama"
  export const LITELLM_PROVIDER_ID = "ollama_chat"

  export class MissingModelError extends Error {
    constructor(readonly modelID: string) {
      super(`Ollama model ${modelID} is not installed.`)
      this.name = "MissingModelError"
    }
  }

  export type PullProgress = {
    status: string
    completed?: number
    total?: number
    percent?: number
  }

  export function isModel(input: { providerID: string; modelID: string } | undefined) {
    return input?.providerID === PROVIDER_ID
  }

  export function isMissingModelError(error: unknown): error is MissingModelError {
    return error instanceof MissingModelError
  }

  export function isModelListed(modelID: string, data: { models?: Array<{ name?: string; model?: string }> }) {
    return (data.models ?? []).some((model) => model.name === modelID || model.model === modelID)
  }

  export function formatMissingModelInstallHint(modelID: string) {
    return `Ollama model ${modelID} is not installed. Run \`ollama pull ${modelID}\` and try again.`
  }

  export function formatProgressBar(percent: number | undefined) {
    if (percent === undefined) return "[--------------------] --%"
    const width = 20
    const filled = Math.round((percent / 100) * width)
    return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${percent}%`
  }

  export function parsePullProgress(input: string): PullProgress | undefined {
    const line = input.trim()
    if (!line) return
    try {
      const data = JSON.parse(line) as { status?: unknown; completed?: unknown; total?: unknown }
      if (typeof data.status !== "string") return
      const completed = typeof data.completed === "number" ? data.completed : undefined
      const total = typeof data.total === "number" ? data.total : undefined
      return {
        status: data.status,
        completed,
        total,
        percent:
          completed !== undefined && total
            ? Math.min(100, Math.max(0, Math.round((completed / total) * 100)))
            : undefined,
      }
    } catch {
      const percentMatch = /(\d{1,3})\s*%/.exec(line)
      const percent = percentMatch ? Math.min(100, Math.max(0, Number(percentMatch[1]))) : undefined
      return {
        status: line,
        percent,
      }
    }
  }

  export function parseWindowsListenerPids(stdout: string) {
    const result = new Set<number>()
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts[0] !== "TCP") continue
      const localAddress = parts[1]
      const state = parts[3]
      const pid = Number(parts[4])
      if (!localAddress?.endsWith(":11434")) continue
      if (state !== "LISTENING") continue
      if (Number.isInteger(pid) && pid > 0) result.add(pid)
    }
    return result
  }

  export function parsePosixListenerPids(stdout: string) {
    return new Set(
      stdout
        .split(/\s+/)
        .map((item) => Number(item.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    )
  }

  export async function ensure(modelID?: string, options?: { onServerStart?: () => void }) {
    if (!(await running())) {
      if (!installed()) {
        throw new Error("Ollama is not installed. Install Ollama from https://ollama.com/download to use local models.")
      }

      register()
      options?.onServerStart?.()
      const child = spawn("ollama", ["serve"], {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      })
      started.add(child)
      child.unref()
      child.once("exit", () => started.delete(child))

      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (await running()) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }

      for (const pid of listenerPids()) {
        ownedListenerPids.add(pid)
      }
    }

    if (!(await running())) {
      throw new Error("Timed out starting Ollama. Run `ollama serve` manually and try again.")
    }

    if (modelID && !(await hasModel(modelID))) {
      throw new MissingModelError(modelID)
    }
  }

  export async function pullModel(modelID: string, options?: { onProgress?: (progress: PullProgress) => void }) {
    await ensure()
    const response = await fetch(pullURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: modelID, stream: true }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`Failed to download Ollama model ${modelID}: ${detail || response.statusText}`)
    }
    if (!response.body) {
      throw new Error(`Failed to download Ollama model ${modelID}: missing progress stream`)
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let leftover = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = leftover + decoder.decode(value, { stream: true })
      const lines = text.split(/\r?\n/)
      leftover = lines.pop() ?? ""
      for (const line of lines) {
        handlePullLine(modelID, line, options)
      }
    }

    const finalLine = leftover + decoder.decode()
    handlePullLine(modelID, finalLine, options)
    await ensure(modelID)
  }

  export function shutdown() {
    for (const child of [...started]) {
      stop(child)
    }
    started.clear()
    for (const pid of [...ownedListenerPids]) {
      stopPid(pid)
    }
    ownedListenerPids.clear()
  }

  async function running() {
    try {
      const response = await fetch(tagsURL, { signal: AbortSignal.timeout(1_000) })
      return response.ok
    } catch {
      return false
    }
  }

  async function hasModel(modelID: string) {
    try {
      const response = await fetch(tagsURL, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) return false
      const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> }
      return isModelListed(modelID, data)
    } catch {
      return false
    }
  }

  function installed() {
    const result = spawnSync("ollama", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    })
    return result.status === 0
  }

  function handlePullLine(modelID: string, line: string, options?: { onProgress?: (progress: PullProgress) => void }) {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const data = JSON.parse(trimmed) as { error?: unknown }
      if (typeof data.error === "string" && data.error) {
        throw new Error(`Failed to download Ollama model ${modelID}: ${data.error}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Failed to download Ollama model")) throw error
    }
    const progress = parsePullProgress(trimmed)
    if (progress) options?.onProgress?.(progress)
  }

  function register() {
    if (handlers) return
    handlers = true
    process.once("exit", shutdown)
    process.once("SIGHUP", () => {
      shutdown()
      process.exit(0)
    })
    process.once("SIGINT", () => {
      shutdown()
      process.exit(130)
    })
    process.once("SIGTERM", () => {
      shutdown()
      process.exit(143)
    })
  }

  function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return
    const pid = child.pid
    if (pid) stopPid(pid)
  }

  function stopPid(pid: number) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        })
        return
      }
      try {
        process.kill(-pid, "SIGTERM")
      } catch {
        process.kill(pid, "SIGTERM")
      }
    } catch (error) {
      log.warn("failed to stop owned Ollama pid", {
        pid,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function listenerPids() {
    if (process.platform === "win32") {
      const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
      })
      if (result.status !== 0) return new Set<number>()
      return parseWindowsListenerPids(result.stdout)
    }

    const result = spawnSync("lsof", ["-ti", "tcp:11434"], {
      encoding: "utf8",
      windowsHide: true,
    })
    if (result.status !== 0) return new Set<number>()
    return parsePosixListenerPids(result.stdout)
  }
}
