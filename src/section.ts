// The lanes section itself: read the Lanes plugin's snapshot and turn it into
// a statusbar section payload.
//
// WHY IT CALLS THE LANES PLUGIN RATHER THAN ITS SOURCES
//
// The Statusbar's own doctrine is that the plugin owning the data should
// publish the section, so the bar stops carrying a copy that silently drifts.
// `bb-plugin-lanes` already knows how to read lane headroom - native
// `bb.sdk.system.usageLimits()` plus the OpenRouter credits API, with the
// credential-ordering subtlety that env.json must win over process.env - and it
// already polls that every 3 minutes into a kv snapshot.
//
// Re-deriving it here would mean a second implementation of the same thing,
// which is exactly the duplication the Statusbar README calls out as a known
// cost. So this reads lanes' snapshot over plugin-to-plugin RPC and does no
// fetching, no credential handling, and no network of its own.
//
// WHAT THAT COSTS
//
// A hard dependency on `bb-plugin-lanes`, the same shape as
// bb-plugin-statusbar-usage's dependency on `bb-plugin-usage`. Without it this
// section renders a visible label rather than data. The Statusbar keeps its own
// built-in lanes reader, so disabling THIS plugin falls back cleanly.
//
// Note that lanes registers its RPC WITHOUT `experimental_discoverable`, so it
// is callable by id but is not itself discoverable as a section provider. That
// is precisely why this plugin exists: it is the shim that republishes lanes'
// data in the section protocol's shape.

import { z } from "zod";
import {
  sectionPayloadSchema,
  unavailableSection,
  type SectionPayload,
  type SectionMetricInput,
} from "@robcopeland/bb-statusbar-section-protocol";

/** The plugin id this section reads from. */
export const LANES_PLUGIN_ID = "lanes";

/**
 * The RPC method and response shape, mirroring bb-plugin-lanes' own contract.
 *
 * Declared here rather than imported because the two plugins are separate
 * repositories with no shared package, and lanes does not publish one. It is
 * deliberately loose (`passthrough` on windows) so a field lanes adds later
 * does not make this section fail validation: an unknown extra key is ignored,
 * where a strict schema would reject the whole reading.
 *
 * The nullable snapshot is real, not defensive: lanes returns null until its
 * first poll has completed, which is possible for the first 3 minutes after a
 * server start.
 */
export const lanesWindowSchema = z
  .object({
    label: z.string(),
    usedPercent: z.number(),
    resetsAt: z.string().nullable(),
  })
  .passthrough();

export const lanesLaneSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["subscription", "metered"]),
    status: z.enum(["ok", "error", "unconfigured"]),
    planLabel: z.string().nullable(),
    windows: z.array(lanesWindowSchema),
    detail: z.string().nullable(),
  })
  .passthrough();

export const lanesSnapshotSchema = z
  .object({
    fetchedAt: z.string(),
    lanes: z.array(lanesLaneSchema),
  })
  .passthrough();

export type LanesSnapshot = z.infer<typeof lanesSnapshotSchema>;
export type LanesLane = z.infer<typeof lanesLaneSchema>;

const TOPIC = "lanes";

/** Mirrors the bar's tone vocabulary: attention at 75%, critical at 90%. */
function toneForPercent(value: number | null): "neutral" | "attention" | "critical" {
  if (value === null) return "neutral";
  if (value >= 90) return "critical";
  if (value >= 75) return "attention";
  return "neutral";
}

/** `27%`, or `4.5%` below 10 so a small number does not read as zero. */
export function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value > 0 && value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

/**
 * `↻4h` / `↻2d` / `↻12m` — when a refilling quota comes back.
 *
 * Returns null for a metered balance, which is signalled by `resetsAt` being
 * null: a pay-as-you-go balance does not refill, so drawing a countdown on it
 * would be a lie.
 */
export function resetLabel(resetsAt: string | null, now: Date = new Date()): string | null {
  if (resetsAt === null) return null;
  const target = new Date(resetsAt).getTime();
  if (!Number.isFinite(target)) return null;
  const seconds = Math.floor((target - now.getTime()) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * The window that matters for a lane: the one furthest consumed.
 *
 * A lane can carry several windows (a 5-hour quota and a weekly one, say). The
 * bar has room for one number per lane, and the useful one is the binding
 * constraint - whichever quota is closest to running out - not the first or the
 * average.
 */
export function worstWindow(lane: LanesLane) {
  if (lane.windows.length === 0) return null;
  let worst = lane.windows[0]!;
  for (const candidate of lane.windows) {
    if (Number(candidate.usedPercent ?? 0) > Number(worst.usedPercent ?? 0)) worst = candidate;
  }
  return worst;
}

/**
 * One metric per lane.
 *
 * `value` is preformatted because the provider that knows the units owns the
 * formatting, and carries the reset countdown where one exists. The `label` is
 * the lane's own short name, since `Claude Code` would crowd a 24px bar.
 */
export function laneMetric(lane: LanesLane): SectionMetricInput {
  // A lane that failed to read still occupies a slot, and says why. Silently
  // dropping it would make an unconfigured provider look like a provider that
  // does not exist.
  if (lane.status !== "ok") {
    return {
      label: shortLaneName(lane),
      value: "—",
      tone: "critical",
      detail: lane.detail ?? `provider reported "${lane.status}"`,
    };
  }

  const worst = worstWindow(lane);
  const used = worst === null ? null : Number(worst.usedPercent ?? 0);
  const reset = worst === null ? null : resetLabel(worst.resetsAt);

  return {
    label: shortLaneName(lane),
    value: `${percent(used)}${reset === null ? "" : ` ↻${reset}`}`,
    tone: toneForPercent(used),
    // Prefer the plugin's own detail (it knows the money figure and whether the
    // balance auto-reloads); fall back to naming the window being shown.
    detail: lane.detail ?? (worst === null ? null : String(worst.label ?? "window")),
  };
}

/**
 * `Claude Code` -> `Claude`; anything already short is left alone.
 *
 * The bar has one compact width and lane names are the widest part of this
 * section, so the second word is the cheapest thing to drop.
 */
export function shortLaneName(lane: LanesLane): string {
  const first = lane.name.split(/\s+/)[0];
  return first && first.length > 0 ? first : lane.name;
}

/**
 * Build the section payload from a lanes snapshot.
 *
 * Ordering is the plugin's courtesy, not a layout decision: the bar owns where
 * the section sits, but within it the lanes are shown in the order lanes
 * reported them, so a lane does not jump position between polls.
 */
export function toSection(snapshot: LanesSnapshot | null): SectionPayload {
  if (snapshot === null) {
    // lanes has not completed its first poll yet. That is a normal warm-up
    // state, not an error, so it is `idle` rather than `error`.
    return unavailableSection({
      topic: TOPIC,
      status: "idle",
      detail: "Lanes has not collected a reading yet.",
    });
  }

  if (snapshot.lanes.length === 0) {
    return unavailableSection({
      topic: TOPIC,
      status: "idle",
      detail: "No lanes configured.",
    });
  }

  const metrics = snapshot.lanes.map(laneMetric);

  // A lanes reading goes stale quietly: the plugin polls every 3 minutes, so if
  // it has been disabled or is failing, the number on screen is an old one
  // rather than an absent one. Say how old, the same way the usage section
  // labels a non-current day.
  const ageMs = Date.now() - new Date(snapshot.fetchedAt).getTime();
  const stale = Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS;

  return sectionPayloadSchema.parse({
    topic: TOPIC,
    status: "ok",
    presentation: "metrics",
    metrics,
    detail: stale ? `Lanes reading is ${describeAge(ageMs)} old.` : null,
  });
}

/** Chosen to be comfortably longer than lanes' 3-minute poll. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/** `4m` / `2h` — short, because it renders inside a 24px bar. */
export function describeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
