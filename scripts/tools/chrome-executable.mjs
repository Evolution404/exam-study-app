import { existsSync } from "node:fs";

/**
 * Keep the browser process isolated from a developer's everyday Chrome.
 * Playwright's bundled Chromium is the default; CHROME_PATH is an explicit
 * escape hatch for debugging a particular external browser build.
 */
export function resolveChromeLaunchOptions({ env = process.env, fileExists = existsSync } = {}) {
  const configured = env.CHROME_PATH?.trim();
  if (configured) {
    if (fileExists(configured)) return { executablePath: configured };
    throw new Error(`CHROME_PATH does not exist: ${configured}`);
  }
  return {};
}

export async function launchProjectChromium(chromium, options = {}, resolverOptions) {
  try {
    return await chromium.launch({
      timeout: 20_000,
      ...options,
      ...resolveChromeLaunchOptions(resolverOptions),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Unable to launch the project test browser. Run \`npm run browser:install\` to install the Playwright Chromium, or verify the explicit CHROME_PATH override. ${detail}`,
      { cause },
    );
  }
}
