// bb-plugin-statusbar-lanes — a Statusbar section provider.
//
// WHAT THIS IS
//
// One discoverable RPC method that returns model lane headroom as a statusbar
// section. The Statusbar plugin finds it on its next discovery tick, matches it
// by topic, and prefers it over its own built-in reader for that topic.
//
// It does not fetch anything itself. It reads the snapshot that bb-plugin-lanes
// already polls every 3 minutes, over plugin-to-plugin RPC, and republishes it
// in the section protocol's shape. See ./section.ts for why that indirection is
// the point rather than an extra hop.
//
// There is no dependency to declare and no install order to respect. BB has no
// plugin dependency mechanism at all — a provider advertises, the bar polls and
// matches:
//
//   You owe it:  one discoverable method returning a valid section payload.
//   It owes you: a slot in the row, and correct degradation if you fail.
//
// IT CLAIMS THE BUILT-IN `lanes` TOPIC
//
// `lanes` is one of the topics the bar ships a fallback reader for, so claiming
// it replaces that reading rather than adding a section beside it. The bar keeps
// its fallback, so disabling this plugin degrades to the built-in rather than
// leaving a gap.
//
// WHY THIS EXISTS AT ALL, GIVEN LANES ALREADY RUNS
//
// lanes registers its RPC without `experimental_discoverable`, so the bar cannot
// discover it as a provider: it is callable by id but invisible to the discovery
// scan. This plugin is the shim that publishes lanes' data in the section
// protocol's shape, which is what makes it visible to the bar.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  sectionActionRequestSchema,
  sectionActionResponseSchema,
  sectionSnapshotResponseSchema,
  unavailableSection,
} from "@robcopeland/bb-statusbar-section-protocol";
import { LANES_PLUGIN_ID, lanesSnapshotSchema, toSection } from "./section.js";

const TOPIC = "lanes";

export const rpcContract = defineRpcContract({
  [SECTION_METHOD_SNAPSHOT]: {
    input: z.null(),
    output: sectionSnapshotResponseSchema,
    experimental_description: "Model lane headroom, as a statusbar section.",
  },
  /**
   * Declared because the bar routes a section's controls back to the plugin
   * that owns them. This section advertises no `actions`, so this exists only
   * to satisfy the contract and to fail clearly if it is ever reached.
   */
  [SECTION_METHOD_ACTION]: {
    input: sectionActionRequestSchema,
    output: sectionActionResponseSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  /**
   * Read lanes' snapshot over RPC.
   *
   * Runs from a HANDLER, never from the factory: `bb.sdk` does not exist until
   * the server is listening, so calling this during plugin setup would fail
   * every time.
   *
   * `outputSchema` is required by the SDK's `callRpc` — it parses the response
   * rather than handing back raw JSON — and passing lanes' own contract shape
   * here is also what keeps the two plugins honest about the wire format.
   *
   * A failure returns null rather than throwing, so the caller renders a
   * degraded section instead of the bar losing the topic.
   */
  async function readLanesSnapshot() {
    try {
      const snapshot = await bb.sdk.plugins.callRpc({
        pluginId: LANES_PLUGIN_ID,
        method: "snapshot",
        input: null,
        // lanes returns `snapshotSchema.nullable()`, so null is a valid answer
        // and means "no poll has completed yet".
        outputSchema: lanesSnapshotSchema.nullable(),
      });
      return snapshot ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Distinguish the two causes, because they need different fixes: lanes is
      // not installed (install it) versus lanes is broken (look at its logs).
      const missing = /not found|unknown plugin|no such plugin|ECONNREFUSED|404/i.test(message);
      throw new LanesUnavailable(missing ? "not-installed" : "failed", message);
    }
  }

  bb.rpc.register(
    rpcContract,
    {
      [SECTION_METHOD_SNAPSHOT]: async () => {
        let section;
        try {
          section = toSection(await readLanesSnapshot());
        } catch (error) {
          // Not an exception thrown at the bar: a section is independently
          // degradable, so a failure becomes a visible label. The message names
          // the actual cause, because "install the Lanes plugin" and "Lanes is
          // returning errors" need different actions from the reader.
          const notInstalled = error instanceof LanesUnavailable && error.kind === "not-installed";
          section = unavailableSection({
            topic: TOPIC,
            status: "error",
            detail: notInstalled
              ? "Lanes plugin not installed \u2014 this section reads its snapshot"
              : `Lanes lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return { generatedAt: new Date().toISOString(), section };
      },

      [SECTION_METHOD_ACTION]: ({ actionId }) => {
        // Reachable only if the section advertises actions, which it does not.
        throw new Error(`The lanes section has no "${actionId}" action.`);
      },
    },
    {
      // THE LINE THAT MAKES THIS A PROVIDER. Without it the method is callable
      // by id, but the bar cannot find it by asking the host which plugins
      // publish section methods.
      experimental_discoverable: true,
      experimental_description: "A model lane headroom section for the Statusbar plugin.",
    },
  );

  bb.log.info(`ready (lanes provider; reading ${LANES_PLUGIN_ID} over RPC)`);
}

/** Distinguishes "lanes is absent" from "lanes is broken", for the reader. */
class LanesUnavailable extends Error {
  constructor(
    readonly kind: "not-installed" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "LanesUnavailable";
  }
}
