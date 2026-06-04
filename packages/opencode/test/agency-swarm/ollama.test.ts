import { describe, expect, test } from "bun:test"
import { AgencySwarmOllama } from "../../src/agency-swarm/ollama"

describe("AgencySwarmOllama", () => {
  test("isModelListed matches Ollama tag names and model ids", () => {
    const tags = {
      models: [{ name: "gemma4:e4b", model: "gemma4:e4b" }, { name: "qwen3:8b" }, { model: "llama3.1:8b" }],
    }

    expect(AgencySwarmOllama.isModelListed("gemma4:e4b", tags)).toBe(true)
    expect(AgencySwarmOllama.isModelListed("qwen3:8b", tags)).toBe(true)
    expect(AgencySwarmOllama.isModelListed("llama3.1:8b", tags)).toBe(true)
    expect(AgencySwarmOllama.isModelListed("qwen3:4b", tags)).toBe(false)
  })

  test("parseWindowsListenerPids returns only Ollama listener pids", () => {
    const output = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:11434        0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:11434        127.0.0.1:50000        ESTABLISHED     1234
  TCP    [::1]:11434            [::]:0                 LISTENING       5678
  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       9999
`

    expect([...AgencySwarmOllama.parseWindowsListenerPids(output)].sort()).toEqual([1234, 5678])
  })

  test("parsePosixListenerPids returns numeric pids", () => {
    expect([...AgencySwarmOllama.parsePosixListenerPids("123\nabc\n456 0 -7\n")]).toEqual([123, 456])
  })

  test("parsePullProgress reads Ollama JSON progress", () => {
    expect(AgencySwarmOllama.parsePullProgress('{"status":"downloading","completed":50,"total":200}')).toEqual({
      status: "downloading",
      completed: 50,
      total: 200,
      percent: 25,
    })
  })

  test("parsePullProgress reads CLI percent progress", () => {
    expect(AgencySwarmOllama.parsePullProgress("pulling manifest 42%")).toEqual({
      status: "pulling manifest 42%",
      percent: 42,
    })
  })

  test("formatProgressBar renders known and unknown progress", () => {
    expect(AgencySwarmOllama.formatProgressBar(undefined)).toBe("[--------------------] --%")
    expect(AgencySwarmOllama.formatProgressBar(25)).toBe("[#####---------------] 25%")
  })
})
