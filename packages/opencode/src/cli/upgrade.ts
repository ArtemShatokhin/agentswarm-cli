import { Bus } from "@/bus"
import { Config } from "@/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import semver from "semver"

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const method = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.method()))
  const info = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.info())).catch(() => undefined)
  const current = info?.version ?? InstallationVersion
  const latest = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.latest(method))).catch(() => {})
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (!semver.gt(latest, current)) return

  await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
}
