import type { HarnessInfo } from "@pincer/core";

export const FALLBACK_HARNESS: HarnessInfo = {
  id: "",
  label: "No harness",
  glyph: "?",
  c1: "#4a4a50",
  c2: "#333338",
  models: [],
  defaultModel: "",
  supportsEffort: false,
};

const EFFORT_DESC: Record<string, string> = {
  off: "No reasoning",
  minimal: "Fastest, least reasoning",
  low: "Quick replies",
  medium: "Balanced",
  high: "Deeper reasoning",
  xhigh: "Extra-deep reasoning",
  max: "Most thorough, slowest",
  auto: "Model decides",
};

const EFFORT_LABEL: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  auto: "Auto",
};

export function effortLabel(e: string): string {
  return EFFORT_LABEL[e.toLowerCase()] ?? e;
}

export function effortDesc(e: string): string {
  return EFFORT_DESC[e.toLowerCase()] ?? "";
}

export function harnessInfo(map: Record<string, HarnessInfo>, id: string): HarnessInfo {
  return map[id] ?? FALLBACK_HARNESS;
}

export function modelLabel(info: HarnessInfo, id: string): string {
  return info.models.find((m) => m.id === id)?.label ?? (id || "Default");
}

export function modelEfforts(info: HarnessInfo, id: string, efforts: string[]): string[] {
  const m = info.models.find((x) => x.id === id);
  return m?.efforts && m.efforts.length ? m.efforts : efforts;
}

export function clampEffort(list: string[], current: string): string {
  if (list.includes(current)) return current;
  return list.includes("high") ? "high" : (list[list.length - 2] ?? list[list.length - 1] ?? current);
}
