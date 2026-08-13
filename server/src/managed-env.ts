// API settings saved by the app are authoritative over values inherited from
// a login shell. Keep this module side-effect free: index.ts imports it before
// the rest of the server so it can apply dotenv's parsed values during boot.

export const MANAGED_API_KEY_NAMES = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_MANAGEMENT_API_KEY',
  'FIRECRAWL_API_KEY',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'CLIPROXYAPI_MANAGEMENT_KEY',
] as const;

export function applyManagedEnv(
  parsed: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  for (const name of MANAGED_API_KEY_NAMES) {
    if (!Object.hasOwn(parsed, name)) continue;
    const value = parsed[name].trim();
    if (value) environment[name] = value;
    else delete environment[name];
  }
}
