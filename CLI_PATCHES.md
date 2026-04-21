# CLI Patches

Changes made to `agentswarm-cli-new` to rebrand to OpenSwarm, harden Agency Swarm auth onboarding, and fix Windows compatibility.

---

## 1. `packages/opencode/src/cli/logo.ts`

**Change:** Replaced the ASCII-art logo with box-drawing glyphs spelling **OPEN** (left panel) and **SWARM** (right panel), displayed side-by-side in the TUI splash screen. Reads as a single word OPENSWARM with one shared S.

```diff
  left: [
    "                            ",
-   " ▓▓    ▓▓   ▓▓▓▓  ▓  ▓  ▓▓▓▓",
-   "▓  ▓  ▓     ▓     ▓▓ ▓   ▓▓ ",
-   "▓▓▓▓  ▓ ▓▓  ▓▓▓   ▓▓▓▓   ▓▓ ",
-   "▓  ▓  ▓  ▓  ▓     ▓ ▓▓   ▓▓ ",
-   "▓  ▓   ▓▓   ▓▓▓▓  ▓  ▓   ▓▓ ",
-   "                            ",
+   " ██████╗ ██████╗ ███████╗███╗   ██╗",
+   "██╔═══██╗██╔══██╗██╔════╝████╗  ██║",
+   "██║   ██║██████╔╝█████╗  ██╔██╗ ██║",
+   "██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║",
+   "╚██████╔╝██║     ███████╗██║ ╚████║",
+   " ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝",
  ],
  right: [
-   "                              ",
-   " ███  █   █   ██   ███   █   █",
-   "█     █   █  █  █  █  █  ██ ██",
-   " ██   █ █ █  ████  ███   █ █ █",
-   "   █  ██ ██  █  █  █ █   █   █",
-   "███    █ █   █  █  █  █  █   █",
-   "                              ",
+   "",
+   "███████╗██╗    ██╗ █████╗ ██████╗ ███╗   ███╗",
+   "██╔════╝██║    ██║██╔══██╗██╔══██╗████╗ ████║",
+   "███████╗██║ █╗ ██║███████║██████╔╝██╔████╔██║",
+   "╚════██║██║███╗██║██╔══██║██╔══██╗██║╚██╔╝██║",
+   "███████║╚███╔███╔╝██║  ██║██║  ██║██║ ╚═╝ ██║",
+   "╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝",
  ],
```

---

## 2. `packages/opencode/src/cli/ui.ts`

**Change:** Replaced the non-TTY wordmark (shown in `--help` output and plain-text contexts) with a single-line box-drawing render of **OPENSWARM** as one word.

```diff
  const wordmark = [
    `⠀                                ▄     `,
-   `█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█`,
-   `█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀`,
-   `▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀`,
+   ` ██████╗ ██████╗ ███████╗███╗   ██╗███████╗██╗    ██╗ █████╗ ██████╗ ███╗   ███╗`,
+   `██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██║    ██║██╔══██╗██╔══██╗████╗ ████║`,
+   `██║   ██║██████╔╝█████╗  ██╔██╗ ██║███████╗██║ █╗ ██║███████║██████╔╝██╔████╔██║`,
+   `██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║╚════██║██║███╗██║██╔══██║██╔══██╗██║╚██╔╝██║`,
+   `╚██████╔╝██║     ███████╗██║ ╚████║███████║╚███╔███╔╝██║  ██║██║  ██║██║ ╚═╝ ██║`,
+   ` ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝`,
  ]
```

---

## 3. `packages/opencode/src/cli/cmd/tui/app.tsx`

Two changes:

### 3a. `/connect` command — smart dialog routing

**Problem:** The `/connect` command always opened the Agency Swarm connection dialog, even when the user was on a non-agency provider where they should see the standard provider auth dialog instead.

**Fix:** Detect the active provider at the time `/connect` is invoked and route to the appropriate dialog.

```diff
+ import { DialogAgencySwarmConnect, DialogAuth, DialogProvider as DialogProviderConnect } from "@tui/component/dialog-provider"
- import { DialogAgencySwarmConnect, DialogAuth } from "@tui/component/dialog-provider"

  onSelect: () => {
-   dialog.replace(() => <DialogAgencySwarmConnect />)
+   const agency = local.model.current()?.providerID === AgencySwarmAdapter.PROVIDER_ID
+   dialog.replace(() => (agency ? <DialogAgencySwarmConnect /> : <DialogProviderConnect />))
  },
```

### 3b. `/onboard` slash command

**Change:** Added a new `/onboard` command that triggers the OpenSwarm setup wizard on next launch by writing a sentinel file at the path stored in `OPENSWARM_ONBOARD_FLAG`, then exiting the TUI.

```diff
+ {
+   title: "Re-run the setup wizard",
+   value: "app.onboard",
+   slash: {
+     name: "onboard",
+   },
+   onSelect: () => {
+     const flagPath = process.env["OPENSWARM_ONBOARD_FLAG"]
+     if (flagPath) {
+       import("fs").then((fs) => fs.writeFileSync(flagPath, "1"))
+     }
+     exit()
+   },
+   category: "System",
+ },
```

---

## 4. `packages/opencode/src/installation/index.ts`

**Problem:** All npm CLI invocations used the bare string `"npm"`, which fails on Windows with `ENOENT: uv_spawn 'npm'` because Windows requires `npm.cmd`.

**Fix:** Added a `npmCmd` constant and replaced all three bare `"npm"` call sites.

```diff
+ const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"

- { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
+ { name: "npm", command: () => text([npmCmd, "list", "-g", "--depth=0"]) },

- const r = (yield* text(["npm", "config", "get", "registry"])).trim()
+ const r = (yield* text([npmCmd, "config", "get", "registry"])).trim()

- result = yield* run(["npm", "install", "-g", `agentswarm-cli@${target}`])
+ result = yield* run([npmCmd, "install", "-g", `agentswarm-cli@${target}`])
```

**Affected call sites:**
- `Installation.method` — detecting whether the package is installed globally via npm
- `Installation.latest` — reading the npm registry URL from npm config
- `Installation.upgrade` — upgrading the package globally via npm

---

## 5. `packages/opencode/src/agency-swarm/npx.ts`

**Problem:** The compiled binary contained an older version of `ensureProjectPython` that ran `npm install` inside the project directory using bare `"npm"`, causing `ENOENT: uv_spawn 'npm'` on Windows. The current source had this step removed entirely, silently dropping node_modules installation for agency projects that ship a `package.json` (e.g. projects using `dom-to-pptx` / Playwright for HTML-to-PPTX conversion). Additionally, `playwright install chromium` was never called during setup.

**Fix:** Re-added the npm install step after Python dependency installation using a Windows-aware command, and added `playwright install chromium` unconditionally.

```diff
  spinner.stop("Python environment ready")
+
+ const nodePackage = path.join(directory, "package.json")
+ if (await Filesystem.exists(nodePackage)) {
+   spinner.start("Installing Node.js dependencies")
+   const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
+   const npmInstall = await runCommand([npmCmd, "install", "--legacy-peer-deps"], { cwd: directory })
+   if (npmInstall.code !== 0) {
+     spinner.stop("Node.js dependency install failed")
+     prompts.log.warn(`npm install: ${npmInstall.stderr.trim() || npmInstall.stdout.trim()}`)
+   } else {
+     spinner.stop("Node.js dependencies installed")
+   }
+ }
+
+ spinner.start("Installing Playwright browsers")
+ await runCommand([venvPython, "-m", "playwright", "install", "chromium"], { cwd: directory })
+ spinner.stop("Playwright browsers installed")
+
  return [venvPython]
```

**Behaviour:**
- npm install only runs if `package.json` exists in the project directory (non-fatal — logs a warning and continues on failure)
- `playwright install chromium` always runs so the browser is available for HTML rendering tools

---

## 6. Agency Swarm auth onboarding hardening (PR #42)

**Files changed:** `session-error.ts`, `dialog-provider.tsx`, `provider-auth.ts`, `app.tsx`

**Problem:** When a user launched in Agency Swarm framework mode without a stored OpenAI/Anthropic credential, or when a credential was rejected mid-session, the TUI either blocked silently or showed a raw error toast with no recovery path. There was also no filtering to ensure only the relevant providers (OpenAI/Anthropic) were shown in framework mode.

### 6a. `session-error.ts` — auth gate logic

Added constants and functions that drive all auth-blocking decisions:

- `AGENCY_SWARM_AUTH_PROVIDER_IDS = ["openai", "anthropic"]` — the only providers accepted in framework mode
- `shouldOpenAgencyAuthDialog(providerID, message)` — returns `true` when the active provider is agency-swarm and the error message indicates a missing/rejected credential (vs. a connection failure, which routes to the connect dialog instead)
- `shouldBlockAgencyPromptSend/Submit(...)` — block prompt submission in framework mode when no supported credential exists; slash commands and shell mode are exempted
- `hasSupportedAgencyCredential(providers, providerAuth)` — checks OAuth-stored credentials in addition to config-level keys, so browser-auth tokens are recognised
- `describeAgencyAuthFailure(message)` — maps raw error strings to user-facing copy:
  - missing credentials → "Add an OpenAI or Anthropic credential before sending a message."
  - rejected key → "The current provider credential was rejected. Reconnect OpenAI or Anthropic and try again."
- `shouldOpenStartupAuthDialog` updated to check `providerAuth` (stored OAuth tokens) in addition to config keys, so the startup dialog is not shown to users who already authenticated via browser

### 6b. `provider-auth.ts` — filter visible auth methods

```diff
+ export function getVisibleProviderAuthMethods(
+   providerID: string,
+   methods: ProviderAuthMethod[],
+   options?: { frameworkMode?: boolean },
+ ) {
+   if (!options?.frameworkMode) return methods
+   if (providerID !== "openai") return methods
+   return methods.filter((item) => !(item.type === "oauth" && /headless/i.test(item.label)))
+ }
```

In framework mode, the "headless" OAuth variant is hidden for OpenAI — only browser sign-in and API key are offered.

### 6c. `dialog-provider.tsx` — scoped auth dialogs

- **`DialogAuth`** now accepts a `providerIDs` filter. In framework mode it restricts to `["openai", "anthropic"]` so the user cannot accidentally connect an unrelated provider.
- **`DialogRemoveCredential`** gains the same `providerIDs` filter so credential removal is also scoped in framework mode.
- Auth method selection dialog title changed from `"Select auth method"` → `"Select <ProviderName> auth method"` for clarity.
- OpenAI provider description changed from `"(ChatGPT Plus/Pro or API key)"` → `"(Browser sign-in or API key)"`.
- Error toasts from failed auth now use `toErrorMessage()` (human-readable) instead of raw `JSON.stringify`, and persist for 5 seconds without auto-clearing the dialog.
- `frameworkMode` is now computed inside `createDialogProviderOptionsWithFilter` so all provider option rows are aware of the mode.

### 6d. `app.tsx` — mid-session auth recovery

When a session message fails, the error handler now checks `shouldOpenAgencyAuthDialog` before falling through to the generic toast:

```diff
+ if (shouldOpenAgencyAuthDialog({ providerID, message })) {
+   toast.show({
+     variant: "error",
+     message: describeAgencyAuthFailure(message),
+     duration: 5000,
+   })
+   dialog.replace(() => <DialogAuth />)
+   return
+ }
```

This means a rejected or missing credential during a running session automatically reopens the auth dialog with a clear explanation, rather than leaving the user with an opaque error.
