import { sha256DigestHex } from "../crypto/sha256";
import type { SyncV7Bytes } from "./sync-v7-head-types";

export function asBytes(value: SyncV7Bytes): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError("immutable v9 file bytes must be text, Uint8Array, or ArrayBuffer");
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

export function digestHex(bytes: Uint8Array): Promise<string> { return sha256DigestHex(bytes); }

export function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
}

export function assertSha1(value: string, field: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new TypeError(`${field} must be a lowercase Git SHA-1 blob id`);
}

export function assertSize(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

export function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function extractBlobSha(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as { content?: unknown; sha?: unknown; existingSha?: unknown };
  if (typeof object.existingSha === "string") return object.existingSha;
  if (object.content && typeof object.content === "object" && !Array.isArray(object.content)) return getString((object.content as { sha?: unknown }).sha);
  return getString(object.sha);
}

function canonicalGitHubVaultIdentity(value: string): string {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return value;
  const repository = value.slice(0, separator);
  const slash = repository.indexOf("/");
  if (slash <= 0 || slash === repository.length - 1) return value;
  const owner = repository.slice(0, slash).toLocaleLowerCase("en-US");
  const repo = repository.slice(slash + 1).toLocaleLowerCase("en-US");
  return `${owner}/${repo}@${value.slice(separator + 1)}`;
}

/** GitHub owner/repository names are case-insensitive; Git ref names are not. */
export function githubVaultIdentitiesEqual(left: string, right: string): boolean {
  return canonicalGitHubVaultIdentity(left) === canonicalGitHubVaultIdentity(right);
}
