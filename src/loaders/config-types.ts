export interface DateRangeConfig {
  param_from: string;
  param_to: string;
  format: "iso" | "iso_date" | "unix" | "unix_ms";
  lookback_days: number;
}

export interface PaginationConfig {
  type: "cursor";
  cursor_param: string;
  cursor_path: string;
  data_path?: string;
}

export function validateDateRangeConfig(raw: unknown): DateRangeConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.param_from !== "string" || !c.param_from) return null;
  if (typeof c.param_to !== "string" || !c.param_to) return null;
  if (!["iso", "iso_date", "unix", "unix_ms"].includes(c.format as string)) return null;
  if (
    typeof c.lookback_days !== "number" ||
    c.lookback_days < 0 ||
    !Number.isFinite(c.lookback_days)
  )
    return null;
  return {
    param_from: c.param_from,
    param_to: c.param_to,
    format: c.format as DateRangeConfig["format"],
    lookback_days: c.lookback_days,
  };
}

export function validatePaginationConfig(raw: unknown): PaginationConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (c.type !== "cursor") return null;
  if (typeof c.cursor_param !== "string" || !c.cursor_param) return null;
  if (typeof c.cursor_path !== "string" || !c.cursor_path) return null;
  if (c.data_path !== undefined && typeof c.data_path !== "string") return null;
  return {
    type: "cursor",
    cursor_param: c.cursor_param,
    cursor_path: c.cursor_path,
    data_path: typeof c.data_path === "string" ? c.data_path : undefined,
  };
}
