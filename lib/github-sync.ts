import { db, applyRemoteEvents, getDeviceId } from "./db";
import type { GitHubSettings, SyncEvent } from "./types";

const api = "https://api.github.com";

function headers(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function encodeBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function decodeBase64(value: string) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function request<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...headers(token), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${response.status}: ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<T>;
}

export async function getGitHubLogin(token: string) {
  const user = await request<{ login: string }>(`${api}/user`, token);
  return user.login;
}

export async function verifyGitHubVault(settings: GitHubSettings, token: string) {
  const branch = settings.branch || "main";
  const tree = await request<{ tree: Array<{ path: string; type: string }> }>(
    `${api}/repos/${settings.owner}/${settings.repo}/git/trees/${branch}?recursive=1`,
    token,
  );
  return tree.tree.filter((entry) => entry.type === "blob" && /^events\/.+\.json$/.test(entry.path)).length;
}

export async function syncWithGitHub(settings: GitHubSettings, token: string) {
  const branch = settings.branch || "main";
  const tree = await request<{
    tree: Array<{ path: string; type: string; sha: string }>;
  }>(`${api}/repos/${settings.owner}/${settings.repo}/git/trees/${branch}?recursive=1`, token);

  const remoteEventFiles = tree.tree.filter(
    (entry) => entry.type === "blob" && /^events\/.+\.json$/.test(entry.path),
  ).sort((a, b) => Number(!a.path.startsWith("events/seed/")) - Number(!b.path.startsWith("events/seed/")) || a.path.localeCompare(b.path));
  let pulled = 0;
  for (const entry of remoteEventFiles) {
    const seen = await db.syncFiles.get(entry.path);
    if (seen?.sha === entry.sha) continue;
    const file = await request<{ content: string }>(
      `${api}/repos/${settings.owner}/${settings.repo}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
      token,
    );
    const events = JSON.parse(decodeBase64(file.content)) as SyncEvent[];
    await applyRemoteEvents(events);
    await db.syncFiles.put({ path: entry.path, sha: entry.sha, appliedAt: new Date().toISOString() });
    pulled += events.length;
  }

  const pending = await db.events.where("synced").equals(0).limit(100).toArray();
  let pushed = 0;
  if (pending.length) {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const path = `events/${getDeviceId()}/${month}/${now.getTime()}-${crypto.randomUUID()}.json`;
    const url = `${api}/repos/${settings.owner}/${settings.repo}/contents/${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await request(url, token, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `sync: ${pending.length} study events`,
            content: encodeBase64(JSON.stringify(pending)),
            branch,
          }),
        });
        await db.events.bulkPut(pending.map((event) => ({ ...event, synced: 1 as const })));
        pushed = pending.length;
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
  }
  return { pulled, pushed };
}
