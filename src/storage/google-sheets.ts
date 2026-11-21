import { decryptConfig } from "../crypto.ts";
import { getCredentialConfig } from "../db/settings.ts";
import { refreshGoogleAccessToken } from "../loaders/google-sheets.ts";
import type { GoogleSheetsCredential } from "../loaders/google-sheets.ts";
import type { Env } from "../types.ts";

export interface SheetsBackendConfig {
  spreadsheetId: string;
  sheetName: string;
  gid?: number;
  credentialId: string;
}

export type SheetsAccess =
  | { ok: true; accessToken: string; config: SheetsBackendConfig }
  | { ok: false; status: 404 | 502; message: string };

// Decrypts a google-sheets storage backend, loads its credential and mints an access token.
export async function getSheetsAccess(
  encryptedBackendConfig: string,
  userId: string,
  env: Env,
): Promise<SheetsAccess> {
  let config: SheetsBackendConfig;
  try {
    config = JSON.parse(
      await decryptConfig(encryptedBackendConfig, env.JWT_SECRET),
    ) as SheetsBackendConfig;
  } catch {
    return { ok: false, status: 502, message: "Bad Gateway" };
  }

  const credRow = await getCredentialConfig(env.DB, config.credentialId, userId);
  if (!credRow || credRow.type !== "google-sheets") {
    return { ok: false, status: 502, message: "google-sheets credential not found" };
  }

  let cred: GoogleSheetsCredential;
  try {
    cred = JSON.parse(
      await decryptConfig(credRow.encrypted_config, env.JWT_SECRET),
    ) as GoogleSheetsCredential;
  } catch {
    return { ok: false, status: 502, message: "Bad Gateway" };
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return { ok: false, status: 502, message: "Google OAuth not configured" };
  }

  try {
    const accessToken = await refreshGoogleAccessToken(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      cred.refreshToken,
    );
    return { ok: true, accessToken, config };
  } catch {
    return { ok: false, status: 502, message: "Failed to refresh Google access token" };
  }
}

// Maps a storage key to a sheet (tab) name: the extension is stripped
// ("sheet_balances.json" → "sheet_balances"); an empty key falls back to the
// backend's configured sheetName, then "Sheet1".
export function sheetNameFromKey(key: string, configuredSheetName?: string): string {
  const base = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : key;
  return base || configuredSheetName || "Sheet1";
}

export type SheetsReadResult =
  | { ok: true; body: string }
  | { ok: false; status: 404 | 502; message: string };

// Reads one sheet tab and returns it as a JSON array of row objects keyed by the header row.
export async function readSheetAsJson(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
): Promise<SheetsReadResult> {
  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}`;
  const res = await fetch(valuesUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    // Google answers 400 for an unknown tab name; surface that as "not found".
    return {
      ok: false,
      status: (res.status === 400 || res.status === 404 ? 404 : 502) as 404 | 502,
      message: `Sheets API error: ${res.status}`,
    };
  }
  const data = (await res.json()) as { values?: string[][] };
  const allRows = data.values ?? [];
  const headers = allRows[0] ?? [];
  const rows = allRows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]!] = row[i] ?? "";
    }
    return obj;
  });
  return { ok: true, body: JSON.stringify(rows) };
}
