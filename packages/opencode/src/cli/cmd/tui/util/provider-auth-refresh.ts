type SessionStatusMap = Record<string, { type: string } | undefined>
type SessionStatusInput = SessionStatusMap | (() => SessionStatusMap)

export function hasActiveSession(status: SessionStatusMap) {
  return Object.values(status).some((item) => item && item.type !== "idle")
}

export async function refreshAfterProviderAuth(input: {
  sessionStatus: SessionStatusInput
  beforeDispose?: () => Promise<unknown>
  dispose: () => Promise<unknown>
  bootstrap: () => Promise<unknown>
  defer?: (task: () => Promise<void>) => unknown
  sleep?: (ms: number) => Promise<unknown>
}) {
  const dispose = async () => {
    await input.beforeDispose?.()
    await input.dispose()
  }

  if (hasActiveSession(readSessionStatus(input.sessionStatus))) {
    await input.bootstrap()
    ;(input.defer ?? ((task) => queueMicrotask(() => void task().catch(() => undefined))))(() =>
      refreshAfterActiveSessionsIdle({
        sessionStatus: input.sessionStatus,
        dispose,
        bootstrap: input.bootstrap,
        sleep: input.sleep,
      }),
    )
    return
  }

  await dispose()
  await input.bootstrap()
}

export async function refreshAfterActiveSessionsIdle(input: {
  sessionStatus: SessionStatusInput
  dispose: () => Promise<unknown>
  bootstrap: () => Promise<unknown>
  sleep?: (ms: number) => Promise<unknown>
}) {
  while (hasActiveSession(readSessionStatus(input.sessionStatus))) {
    await (input.sleep ?? sleep)(1000)
  }
  await input.dispose()
  await input.bootstrap()
}

function readSessionStatus(input: SessionStatusInput) {
  return typeof input === "function" ? input() : input
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
