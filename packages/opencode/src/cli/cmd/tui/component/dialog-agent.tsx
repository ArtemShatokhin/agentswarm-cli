import { AgencySwarmAdapter } from "@/agency-swarm/adapter"
import { prepareLocalProjectRunLaunch } from "@/agency-swarm/npx"
import { AgencySwarmRunSession } from "@/agency-swarm/run-session"
import { displayAgentName } from "@/agent/display"
import { Config } from "@/config"
import { useLocal, type ProductMode } from "@tui/context/local"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { createMemo, createResource } from "solid-js"
import { DialogAgencySwarmConnect } from "./dialog-provider"
import { isAgencySwarmFrameworkMode } from "../session-error"
import {
  buildAgencyTargetOptions,
  readAgencyProviderOptions,
  resolveAgencyTargetFromPicker,
  resolveAgencyTargetSelection,
} from "../util/agency-target"

type AgentOptionValue =
  | {
      kind: "mode"
      mode: ProductMode
    }
  | {
      kind: "local"
      agent: string
    }
  | {
      kind: "agency"
      agency: string
    }
  | {
      kind: "recipient"
      agency: string
      recipientAgent: string
    }
  | {
      kind: "connect"
    }

export function DialogAgent() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  const currentModel = createMemo(() => local.model.current())
  const agencySwarmEnabled = createMemo(() =>
    isAgencySwarmFrameworkMode({
      currentProviderID: currentModel()?.providerID,
      configuredModel: sync.data.config.model,
      agentModel: local.agent.current()?.model,
      productMode: local.product?.current(),
    }),
  )

  const providerOptions = createMemo(() => {
    return readAgencyProviderOptions({
      configuredProvider: sync.data.config.provider?.[AgencySwarmAdapter.PROVIDER_ID],
      connectedProvider: sync.data.provider.find((item) => item.id === AgencySwarmAdapter.PROVIDER_ID),
    })
  })

  const discoveryInput = createMemo(() => {
    if (!agencySwarmEnabled()) return undefined
    return {
      baseURL: providerOptions().baseURL,
      token: providerOptions().token,
      timeoutMs: providerOptions().discoveryTimeoutMs,
    }
  })

  const [discovery] = createResource(
    discoveryInput,
    async (input): Promise<{ agencies: AgencySwarmAdapter.AgencyDescriptor[]; error?: string }> => {
      try {
        const result = await AgencySwarmAdapter.discover({
          baseURL: input.baseURL,
          token: input.token,
          timeoutMs: input.timeoutMs,
        })
        return { agencies: result.agencies }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error
        return {
          agencies: [],
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    {
      initialValue: { agencies: [] },
    },
  )

  const options = createMemo<DialogSelectOption<AgentOptionValue>[]>(() => {
    const product = local.product.current()
    const modes: DialogSelectOption<AgentOptionValue>[] = [
      {
        value: {
          kind: "mode",
          mode: "plan",
        },
        title: "Plan",
        description: "Plan work before building",
      },
      {
        value: {
          kind: "mode",
          mode: "build",
        },
        title: "Build",
        description: "Agent Builder for swarms and agents",
      },
      ...(product === "run"
        ? []
        : [
            {
              value: {
                kind: "mode" as const,
                mode: "run" as const,
              },
              title: "Run",
              description: "Use the connected swarm",
            },
          ]),
    ]

    if (!agencySwarmEnabled()) {
      return [
        ...modes,
        ...local.agent
          .list()
          .filter((item) => item.name !== "build" && item.name !== "plan")
          .map((item) => {
            return {
              value: {
                kind: "local",
                agent: item.name,
              } as AgentOptionValue,
              title: displayAgentName(item.name),
              description: item.native ? "native" : item.description,
            }
          }),
      ]
    }

    const result: DialogSelectOption<AgentOptionValue>[] = [...modes]
    const discovered = discovery()
    const error = discovered?.error

    if (discovery.loading && !error) {
      result.push({
        value: {
          kind: "agency",
          agency: "__loading__",
        },
        title: "Discovering agency-swarm agents...",
        disabled: true,
        category: "agency-swarm",
      })
      return result
    }

    if (error) {
      result.push({
        value: {
          kind: "agency",
          agency: "__error__",
        },
        title: "Agency discovery failed",
        description: error,
        disabled: true,
        category: "agency-swarm",
      })
      result.push({
        value: {
          kind: "connect",
        },
        title: "Open /connect",
        description: "Select a local server or update token",
        category: "agency-swarm",
      })
      return result
    }

    const agencies = discovered?.agencies ?? []
    for (const agency of agencies) {
      const category = `Swarm: ${agency.name}`
      const entry = agency.agents.find((agent) => agent.isEntryPoint) ?? agency.agents[0]
      const description =
        agency.description && agency.description !== entry?.description ? agency.description : undefined
      result.push({
        value: {
          kind: "agency",
          agency: agency.id,
        },
        title: agency.name,
        description,
        category,
      })
      for (const agent of agency.agents) {
        result.push({
          value: {
            kind: "recipient",
            agency: agency.id,
            recipientAgent: agent.id,
          },
          title: `- ${agent.name}`,
          description: agent.description || (agent.isEntryPoint ? "Entry point" : undefined),
          category,
        })
      }
    }

    if (result.length === modes.length) {
      result.push({
        value: {
          kind: "agency",
          agency: "__empty__",
        },
        title: "No agencies discovered",
        description: `Check ${providerOptions().baseURL} and run \`agentswarm agency agencies\``,
        disabled: true,
        category: "agency-swarm",
      })
    }

    return result
  })

  const current = createMemo<AgentOptionValue | undefined>(() => {
    const product = local.product?.current()
    const agent = local.agent.current()?.name
    if (!agencySwarmEnabled() && agent && agent !== "build" && agent !== "plan") {
      return {
        kind: "local",
        agent,
      }
    }

    if (product === "build" || product === "plan") {
      return {
        kind: "mode",
        mode: product,
      }
    }

    if (!agencySwarmEnabled()) {
      return {
        kind: "local",
        agent: agent ?? "build",
      }
    }

    const selected = resolveAgencyTargetSelection({
      agencies: discovery()?.agencies ?? [],
      configuredAgency: providerOptions().agency,
      configuredRecipient: providerOptions().recipientAgent,
    })
    if (selected) {
      if (!selected.recipientAgent) {
        return {
          kind: "agency",
          agency: selected.agency,
        }
      }
      return {
        kind: "recipient",
        agency: selected.agency,
        recipientAgent: selected.recipientAgent,
      }
    }

    if (providerOptions().agency) {
      return {
        kind: "agency",
        agency: providerOptions().agency!,
      }
    }

    return undefined
  })

  return (
    <DialogSelect
      title="Select agent"
      current={current()}
      options={options()}
      onSelect={(option) => {
        if (option.value.kind === "mode") {
          void setProductMode(option.value.mode)
          return
        }

        if (option.value.kind === "local") {
          local.agent.set(option.value.agent)
          dialog.clear()
          return
        }

        if (option.value.kind === "connect") {
          dialog.replace(() => <DialogAgencySwarmConnect />)
          return
        }

        void setAgencySwarmTarget(option.value).catch((error) => {
          toast.show({
            variant: "error",
            message: error instanceof Error ? error.message : String(error),
            duration: 6000,
          })
        })
      }}
    />
  )

  async function setProductMode(mode: ProductMode) {
    try {
      if (mode === "run") {
        await prepareLocalRunProject()
      }
      await local.product.set(mode)
      dialog.clear()
    } catch (error) {
      toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : String(error),
        duration: 8000,
      })
    }
  }

  async function prepareLocalRunProject() {
    const directory =
      process.env[AgencySwarmRunSession.PENDING_LOCAL_PROJECT_ENV] ??
      process.env[AgencySwarmRunSession.LOCAL_PROJECT_ENV]
    if (!directory) return
    const launch = await prepareLocalProjectRunLaunch(directory, undefined, readPendingRunPythonCommand())
    const enabled = sync.data.config.enabled_providers
      ? Array.from(new Set([...sync.data.config.enabled_providers, AgencySwarmAdapter.PROVIDER_ID]))
      : undefined
    const disabled = sync.data.config.disabled_providers?.filter((item) => item !== AgencySwarmAdapter.PROVIDER_ID)
    const config = {
      ...launch.config,
      ...(enabled ? { enabled_providers: enabled } : {}),
      ...(disabled ? { disabled_providers: disabled } : {}),
    } satisfies Config.Info
    await sdk.client.global.config.update(
      {
        config,
      },
      {
        throwOnError: true,
      },
    )
    process.env[AgencySwarmRunSession.LOCAL_PROJECT_ENV] = launch.runProjectDirectory
    delete process.env[AgencySwarmRunSession.PENDING_LOCAL_PROJECT_ENV]
    delete process.env[AgencySwarmRunSession.PENDING_LOCAL_PROJECT_PYTHON_ENV]
    await sdk.client.instance.dispose()
    await sync.bootstrap()
  }

  function readPendingRunPythonCommand() {
    const value = process.env[AgencySwarmRunSession.PENDING_LOCAL_PROJECT_PYTHON_ENV]
    if (!value) return
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string")) return parsed
    throw new Error("Pending Agent Swarm Python command is invalid. Restart Agent Swarm and try Run again.")
  }

  async function setAgencySwarmTarget(value: Extract<AgentOptionValue, { kind: "agency" | "recipient" }>) {
    const options = providerOptions()
    const selected = resolveAgencyTargetFromPicker({
      agencies: discovery()?.agencies ?? [],
      selectedAgency: value.agency,
      selectedRecipient: value.kind === "recipient" ? value.recipientAgent : undefined,
    })
    const nextOptions = buildAgencyTargetOptions({
      providerOptions: options,
      agency: value.agency,
      recipientAgent: selected?.recipientAgent ?? null,
    })

    await sdk.client.global.config.update(
      {
        config: {
          model: `${AgencySwarmAdapter.PROVIDER_ID}/${AgencySwarmAdapter.DEFAULT_MODEL_ID}`,
          provider: {
            [AgencySwarmAdapter.PROVIDER_ID]: {
              name: "agency-swarm",
              options: nextOptions,
            },
          },
        },
      },
      {
        throwOnError: true,
      },
    )

    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.clear()

    const selectedMessage =
      value.kind === "agency"
        ? `Selected swarm ${selected?.agencyLabel ?? value.agency}`
        : `Selected ${selected?.label ?? value.recipientAgent} in swarm ${selected?.agencyLabel ?? value.agency}`
    toast.show({
      variant: "success",
      message: selectedMessage,
      duration: 3000,
    })
  }
}
