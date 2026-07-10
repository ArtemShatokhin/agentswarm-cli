import { createWriteStream, existsSync, statSync } from "node:fs"

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  timedOut?: boolean
  logFile?: string
}

export class StartupCancelledError extends Error {
  constructor() {
    super("Startup cancelled.")
  }
}

export function isStartupCancelledError(error: unknown) {
  return error instanceof StartupCancelledError
}

export function throwIfStartupCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new StartupCancelledError()
}

interface RunCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  logFile?: string
  signal?: AbortSignal
  streamOutputToStderr?: boolean
  suppressPythonTracebackStderr?: boolean
  timeoutMs?: number
}

interface OutputWriter {
  write: (chunk: string) => void
  close?: () => void
}

const PROCESS_KILL_GRACE_MS = 5000

export function summarizePythonTraceback(output: string) {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  if (!lines.some((line) => line.trim() === "Traceback (most recent call last):")) return ""
  return lines.findLast(isPythonTracebackFinalExceptionLine)?.trim() ?? ""
}

function isPythonTracebackFinalExceptionLine(line: string) {
  if (/^\s/.test(line)) return false
  return /^[A-Za-z_][\w.]*:(?:\s|$)/.test(line.trimEnd())
}

export function resolveLauncherCommand(cmd: string[], platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return cmd
  const executable = cmd[0]?.toLowerCase()
  if (executable === "npm" || executable === "npx") return ["cmd.exe", "/c", ...cmd]
  return cmd
}

export async function runCommand(cmd: string[], options?: RunCommandOptions): Promise<CommandResult> {
  const commandLog = openCommandLog(options?.logFile)
  const writeChunk = (chunk: string, streamToStderr: boolean) => {
    if (streamToStderr) {
      try {
        process.stderr.write(chunk)
      } catch {}
    }
    commandLog.write(chunk)
  }
  const stderrWriter = createStderrCommandWriter({
    commandLog,
    streamToStderr: options?.streamOutputToStderr === true,
    suppressPythonTracebacks: options?.suppressPythonTracebackStderr === true,
  })
  try {
    throwIfStartupCancelled(options?.signal)
    const proc = Bun.spawn({
      cmd: resolveLauncherCommand(cmd),
      cwd: options?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: options?.env ?? process.env,
    })
    const outputAbort = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let cancelRun: (() => void) | undefined
    const cancelResult =
      options?.signal === undefined
        ? undefined
        : new Promise<{ code: -1; timedOut: false; cancelled: true }>((resolve) => {
            cancelRun = () => {
              try {
                proc.kill()
              } catch {}
              outputAbort.abort()
              forceKill = globalThis.setTimeout(() => {
                try {
                  proc.kill("SIGKILL")
                } catch {}
              }, PROCESS_KILL_GRACE_MS)
              resolve({ code: -1, timedOut: false, cancelled: true })
            }
          })
    if (options?.signal?.aborted) cancelRun?.()
    else if (cancelRun) options?.signal?.addEventListener("abort", cancelRun, { once: true })
    const exitPromise = proc.exited.finally(() => {
      if (timeout) globalThis.clearTimeout(timeout)
      if (forceKill) globalThis.clearTimeout(forceKill)
      if (options?.signal && cancelRun) options.signal.removeEventListener("abort", cancelRun)
    })
    const exitResult = exitPromise.then((code) => ({ code, timedOut: false as const }))
    const timeoutResult =
      options?.timeoutMs === undefined
        ? undefined
        : new Promise<{ code: number; timedOut: true }>((resolve) => {
            timeout = globalThis.setTimeout(() => {
              resolve({ code: -1, timedOut: true })
              void (async () => {
                try {
                  proc.kill()
                } catch {}
                const timeoutKill = globalThis.setTimeout(() => {
                  try {
                    proc.kill("SIGKILL")
                  } catch {}
                }, PROCESS_KILL_GRACE_MS)
                await exitPromise.catch(() => undefined)
                globalThis.clearTimeout(timeoutKill)
                outputAbort.abort()
              })()
            }, options.timeoutMs)
          })
    const resultPromise = cancelResult
      ? timeoutResult
        ? Promise.race([exitResult, timeoutResult, cancelResult])
        : Promise.race([exitResult, cancelResult])
      : timeoutResult
        ? Promise.race([exitResult, timeoutResult])
        : exitResult
    const [result, stdout, stderr] = await Promise.all([
      resultPromise,
      readCommandOutput(
        proc.stdout,
        (chunk) => writeChunk(chunk, options?.streamOutputToStderr === true),
        outputAbort.signal,
      ),
      readCommandOutput(proc.stderr, stderrWriter, outputAbort.signal),
    ])
    if ("cancelled" in result) throw new StartupCancelledError()
    const logFile = await closeCommandLog(commandLog)
    return { code: result.code, stdout, stderr, timedOut: result.timedOut, logFile }
  } catch (error) {
    const logFile = await closeCommandLog(commandLog)
    if (isStartupCancelledError(error)) throw error
    return {
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      logFile,
    }
  }
}

function openCommandLog(logFile?: string) {
  if (!logFile) {
    return {
      getLogFile: () => undefined,
      write(_chunk: string) {},
      async close() {},
    }
  }

  let activeLogFile: string | undefined = logFile
  let stream: ReturnType<typeof createWriteStream> | undefined
  const disable = () => {
    activeLogFile = undefined
    if (!stream) return
    stream.destroy()
    stream = undefined
  }

  try {
    if (existsSync(logFile) && statSync(logFile).isDirectory()) {
      disable()
      return {
        getLogFile: () => undefined,
        write(_chunk: string) {},
        async close() {},
      }
    }
    stream = createWriteStream(logFile, { flags: "a" })
    stream.on("error", () => {
      disable()
    })
  } catch {
    disable()
  }

  return {
    getLogFile: () => activeLogFile,
    write(chunk: string) {
      if (!stream) return
      try {
        stream.write(chunk)
      } catch {
        disable()
      }
    },
    async close() {
      if (!stream) return
      await new Promise<void>((resolve, reject) => {
        stream?.end((error?: Error | null) => {
          if (error) reject(error)
          else resolve()
        })
      }).catch(() => undefined)
      stream = undefined
    },
  }
}

function createStderrCommandWriter(input: {
  commandLog: ReturnType<typeof openCommandLog>
  streamToStderr: boolean
  suppressPythonTracebacks: boolean
}): OutputWriter {
  const userWriter = createUserStderrWriter(input.streamToStderr, input.suppressPythonTracebacks)
  return {
    write(chunk) {
      input.commandLog.write(chunk)
      userWriter.write(chunk)
    },
    close() {
      userWriter.close?.()
    },
  }
}

function createUserStderrWriter(streamToStderr: boolean, suppressPythonTracebacks: boolean): OutputWriter {
  let pending = ""
  let suppressingTraceback = false

  const writeLine = (line: string) => {
    const trimmed = line.trim()
    if (suppressPythonTracebacks && !suppressingTraceback && trimmed === "Traceback (most recent call last):") {
      suppressingTraceback = true
      return
    }
    if (suppressingTraceback) {
      if (isPythonTracebackFinalExceptionLine(line)) suppressingTraceback = false
      return
    }
    if (!streamToStderr) return
    try {
      process.stderr.write(line)
    } catch {}
  }

  return {
    write(chunk) {
      const text = pending + chunk
      const lines = text.split(/(?<=\n)/)
      pending = lines.at(-1)?.endsWith("\n") ? "" : (lines.pop() ?? "")
      for (const line of lines) {
        writeLine(line)
      }
    },
    close() {
      if (!pending) return
      writeLine(pending)
      pending = ""
    },
  }
}

async function closeCommandLog(log: ReturnType<typeof openCommandLog>) {
  await log.close()
  return log.getLogFile()
}

function writeOutput(writer: ((chunk: string) => void) | OutputWriter, chunk: string) {
  if (typeof writer === "function") writer(chunk)
  else writer.write(chunk)
}

function closeOutputWriter(writer: ((chunk: string) => void) | OutputWriter | undefined) {
  if (typeof writer === "function") return
  writer?.close?.()
}

async function readCommandOutput(
  output: string | ReadableStream<Uint8Array> | null | undefined,
  writer?: ((chunk: string) => void) | OutputWriter,
  signal?: AbortSignal,
) {
  if (typeof output === "string") {
    if (output && writer) writeOutput(writer, output)
    closeOutputWriter(writer)
    return output
  }
  if (!output) return ""

  const reader = output.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const abortRead = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener("abort", abortRead, { once: true })
  if (signal?.aborted) abortRead()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done || signal?.aborted) break
      if (!value || value.length === 0) continue
      const chunk = decoder.decode(value, { stream: true })
      if (writer) writeOutput(writer, chunk)
      text += chunk
    }
    const tail = decoder.decode()
    if (tail) {
      if (writer) writeOutput(writer, tail)
      text += tail
    }
    return text
  } catch (error) {
    if (signal?.aborted) return text
    throw error
  } finally {
    closeOutputWriter(writer)
    signal?.removeEventListener("abort", abortRead)
  }
}
