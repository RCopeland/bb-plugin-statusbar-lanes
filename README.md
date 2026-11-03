# bb-plugin-statusbar-lanes

A [Statusbar](https://github.com/RCopeland/bb-plugin-statusbar) section provider
that shows model lane headroom in the bar:

```
$0.03 today │ OpenRouter $44.84 │ CPU 34% MEM 51% DISK 9% │ 14:32 Mon 13 Oct
MTD $6.27 · $44.84 of $65.00 left — no auto-reload
```

One metric per lane. A **metered** lane (OpenRouter) shows its remaining balance
in dollars; a **subscription** lane (Claude Code, Codex) shows the **worst**
window's percentage — whichever quota is closest to running out. Refilling
quotas carry a reset countdown (`↻4h`); a metered balance does not, because a
pay-as-you-go balance does not refill on its own and a countdown on it would be
a lie.

**Why a metered lane shows dollars and not a percentage.** lanes reports a
metered lane's `usedPercent` as `spent / lifetime-purchased`, which is a
*purchase* ratio rather than a burn rate: it barely moves between polls and never
resets, so as a headline number it is close to a constant. The balance is the
figure that carries information, so it wins where it is available.

## What it is, and what it is not

It is a **section provider**, not a bar and not a data collector. It does not
draw anything, does not choose its position in the row, and cannot ship UI into
the bar. It publishes one discoverable RPC method returning data.

It also **does not fetch lane data.** That is the point of the design: it reads
the snapshot `bb-plugin-lanes` already collects and republishes it in the
section protocol's shape. See below.

## Install

```sh
git clone <this repo>
cd bb-plugin-statusbar-lanes
npm install
bb plugin build .
bb plugin install . --yes
```

Requirements:

- **bb ≥ 0.44** (see `engines`).
- **`bb-plugin-lanes`** — required, see below.
- The **Statusbar** plugin installed and running. This is what renders the
  section; without it nothing calls this plugin.
- Node ≥ 22.

## This plugin requires bb-plugin-lanes

**`bb-plugin-lanes` must be installed and running. It is not optional.** This
plugin has no data source of its own — it makes a single RPC call to lanes and
returns the answer.

```sh
# Install the Lanes plugin first, if it is not already present.
bb plugin install git:https://github.com/slogsdon/bb-plugin-lanes.git --yes
```

If lanes is missing, the section renders an error label rather than a blank bar
or a wrong number, and the label says which problem it is:

| Situation | What the bar shows |
|---|---|
| lanes not installed | `Lanes plugin not installed — this section reads its snapshot` |
| lanes disabled or stopped | `Lanes lookup failed: HTTP 503: plugin "lanes" is not running (status: disabled)` |
| lanes running, first poll pending | `Lanes has not collected a reading yet.` (idle, not an error) |
| lanes running, data stale | normal metrics + `Lanes reading is 12m old.` |

The third case is a real warm-up state, not a failure: lanes polls every 3
minutes, so for the first 3 minutes after a server start its snapshot is `null`.

### Why it reads lanes over RPC instead of fetching

The Statusbar's own doctrine is that **the plugin owning the data should publish
the section**, so the bar stops carrying a copy that silently drifts. Its README
puts it plainly:

> `bb-plugin-lanes` knows how to read lane headroom; the bar should not
> re-derive it.

`bb-plugin-lanes` already owns the non-obvious parts: native
`bb.sdk.system.usageLimits()`, the OpenRouter credits API, and the
credential-ordering rule that `env.json` must win over `process.env` (because
`process.env` is a snapshot from server start and serves revoked keys after a
rotation). Re-deriving any of that here would mean a second implementation that
drifts from the first.

**So this plugin makes one RPC call and does no fetching, no credential
handling, and no network of its own.** CI enforces that, so the duplication
cannot creep back in.

> **Coupling:** it depends on lanes' `snapshot` RPC shape. The schema here is
> deliberately lenient (`.passthrough()`) so a field lanes adds later does not
> break the section, but a *removed* or *renamed* required field would. Pin
> lanes to a version if you want that guarantee.

## It claims the built-in `lanes` topic

The Statusbar plugin ships its own fallback reader for `lanes`, which duplicates
some of lanes' logic. Claiming the topic means this plugin **replaces** that
reading.

The bar keeps its fallback, so disabling or uninstalling this plugin returns the
slot to the built-in rather than leaving a gap — verified by disabling the
plugin and observing `lanes` go back to `kind: "builtin"`:

```sh
bb plugin rpc call statusbar providers --json
bb plugin rpc call statusbar snapshot --json   # see `sources`
```

## Why a separate plugin is needed at all

`bb-plugin-lanes` registers its RPC methods **without**
`experimental_discoverable`. They are callable by id, but the Statusbar's
discovery scan cannot see them, so the bar cannot treat lanes as a provider.

This plugin is the shim that republishes lanes' data in the protocol's shape —
which is what makes it visible to the bar. It is deliberately tiny: the whole
plugin is one RPC call plus formatting.

## Design notes

**Worst window wins.** A lane can carry several windows (a 5-hour quota and a
weekly one). The bar has room for one number per lane, and the useful one is the
binding constraint — whichever quota is closest to running out — not the first
or the average.

**The balance is scraped from lanes' detail sentence.** lanes does not publish a
metered lane's dollar amount as a field — its window payload is `{label,
usedPercent, resetsAt}` — so the only place it exists is prose, as `"$44.84 of
$65.00 left — no auto-reload"`. This plugin parses that sentence, because the
alternatives are worse: adding the field means altering an upstream plugin,
and fetching OpenRouter directly means duplicating the credential handling the
split exists to avoid (and CI forbids it).

That parse is therefore **coupled to lanes' wording**, and it is the only place
in this plugin that reads content out of another plugin's prose rather than
republishing fields. If the sentence is reworded the match fails and the metric
degrades to the percentage — a less useful number, but never a wrong one. The
match is anchored on `of $` rather than the first `$` so an inverted rewrite can
never surface the lifetime purchase total as the balance.

**A metered lane is never toned by its percentage.** The bar's 75%/90%
thresholds mean "bad news", but a balance shows *headroom*, where a high number
is good — applying them would paint a healthy balance as alarming. Metered lanes
are toned neutral rather than having dollar thresholds invented for them.

**Stale data is labelled.** lanes polls every 3 minutes, so a reading can go
stale quietly if the plugin is stopped: the number on screen would be old rather
than absent. Past 10 minutes the section says how old, the same way the usage
section labels a non-current day.

**A broken lane keeps its slot.** A lane that failed to read still renders, as
`—` with the reason, rather than disappearing. Silently dropping it would make
an unconfigured provider look like a provider that does not exist.

**Failure degrades locally.** The section returns a visible label rather than
throwing, so one failing provider never blanks the bar.

## Development

```sh
npm run typecheck
npm run build
bb plugin install . --yes
bb plugin reload statusbar-lanes

# Confirm the bar picked it up (up to 10s discovery lag)
bb plugin rpc call statusbar providers --json
bb plugin rpc call statusbar snapshot --json

# Call the section directly, bypassing the bar
bb plugin rpc call statusbar-lanes section.v1.snapshot --json
```

## License

MIT
