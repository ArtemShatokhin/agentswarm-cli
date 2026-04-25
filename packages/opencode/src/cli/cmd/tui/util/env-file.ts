import { existsSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"

/**
 * Write a key=value pair to the project's .env file (process.cwd()/.env).
 * Creates the file if it doesn't exist. Overwrites an existing key in-place.
 * Value is single-quoted to match python-dotenv's set_key output format.
 */
export function writeEnvKey(key: string, value: string): void {
  const envPath = resolve(process.cwd(), ".env")
  let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : ""
  const line = `${key}='${value.replace(/'/g, "\\'")}'`
  const regex = new RegExp(`^${key}\\s*=.*$`, "m")
  if (regex.test(content)) {
    content = content.replace(regex, line)
  } else {
    content = content.trimEnd()
    content = content ? `${content}\n${line}` : line
  }
  writeFileSync(envPath, content + "\n", { encoding: "utf-8", mode: 0o600 })
}

/**
 * Read a key from the project's .env file, returning undefined if not found.
 */
export function readEnvKey(key: string): string | undefined {
  const envPath = resolve(process.cwd(), ".env")
  if (!existsSync(envPath)) return undefined
  const content = readFileSync(envPath, "utf-8")
  const match = content.match(new RegExp(`^${key}\\s*=\\s*['"]?([^'"\\n]*)['"]?`, "m"))
  return match?.[1]?.trim() || undefined
}
