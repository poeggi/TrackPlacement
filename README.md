# TrackPlacement

A server-side Bedrock Dedicated Server (BDS) behavior pack that monitors placement and use of dangerous items and blocks. Alerts are broadcast in-game to all online players and logged to the server console. No cheats required. No client-side installation needed.

## Features

- Tracks block placements (TNT, Respawn Anchor, End Crystal, and more)
- Tracks items loaded into dispensers, droppers, and hoppers (automation chain detection)
- Tracks items held when interacting with entities (TNT minecarts)
- Tracks items acquired via crafting or pickup
- Detects entities fired from dispensers/droppers
- Dimension-aware tracking — e.g. beds can be restricted to Nether/The End only
- Rate-limiting with configurable windows — bursts are summarised rather than spammed
- Nearby events are clustered by location to reduce noise
- All events logged to console regardless of in-game alert settings
- Operator commands available when Beta APIs are enabled on the world

## Requirements

- Minecraft Bedrock Dedicated Server 1.21.0 or later
- `@minecraft/server` API version 2.1.0 (stable, no experiments required for core tracking)
- Beta APIs experiment enabled on the world **only if** you want operator chat commands

## Installation

1. Copy `TrackPlacement_BP/` into your server's `behavior_packs/` directory.

2. Register the pack for your world by editing `worlds/<world-name>/world_behavior_packs.json`:

```json
[
  {
    "pack_id": "560fee0a-73c1-4f03-9c27-3ae8ba58344a",
    "version": [1, 0, 0]
  }
]
```

3. Restart the server.

## File Structure

```
TrackPlacement_BP/
├── manifest.json
└── scripts/
    ├── main.js              — core tracking logic and operator commands
    └── tracked_blocks.js    — configuration: what to track and how
```

## Configuration

All tracking is configured in `scripts/tracked_blocks.js`. Edit this file to add, remove, or adjust tracked items. Changes take effect on server restart.

### Global settings

```js
export const chat_alerts = true;
// Set to false to suppress in-game broadcast alerts.
// Console logging and operator commands are unaffected.
```

### Entry fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Minecraft block/item/entity type ID |
| `label` | yes | Display name shown in alerts |
| `alert_color` | yes | Chat color code (see below) |
| `window_ticks` | yes | Rate-limit window in ticks. 20 ticks = 1 second. `0` = alert every occurrence immediately |
| `dimensions` | no | Array of dimension IDs to restrict tracking to. Omit to track everywhere |

**Color codes:** `\u00a7c` red · `\u00a76` gold · `\u00a7e` yellow · `\u00a7d` purple · `\u00a7b` cyan · `\u00a7a` green

**Dimension IDs:** `"minecraft:overworld"` · `"minecraft:nether"` · `"minecraft:the_end"`

### Example: track beds only in Nether and The End

```js
{ id: "minecraft:red_bed", label: "Bed (Red)", alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] }
```

Beds are harmless in the Overworld but explode instantly in the Nether and The End. The config ships with all 16 bed colors as commented-out entries ready to enable.

## Detection types

| Type | Trigger |
|---|---|
| `PLACE` | Tracked block placed directly in the world |
| `CONTAINER` | Player opens a dispenser, dropper, or hopper while holding a tracked item |
| `ENTITY` | Player interacts with a tracked entity while holding a tracked item |
| `CRAFT/PICKUP` | Tracked item added to a player's inventory |
| `DISPENSER` | Tracked entity spawned adjacent to a dispenser or dropper |

## Console log format

```
[TrackPlacement] [PLACE] PiCraft3 | TNT (tnt) | (-240, 136, 74) | Overworld | #1
[TrackPlacement] [PLACE x3 +more] PiCraft3 | TNT (tnt) | near (-240, 136, 74) (x3) | Overworld | #4
```

## Operator commands

Chat commands require **Beta APIs** to be enabled on the world. When enabled, type the following directly in chat (press `t` or `/`):

| Command | Description |
|---|---|
| `track help` | Show all commands |
| `track ignore add <player>` | Ignore a player's activity this session |
| `track ignore remove <player>` | Remove a player's ignore |
| `track ignore list` | List all currently ignored players, including who set them and when |
| `track offenders [count]` | Show last N tracked events (default: 3). Includes ignored players, marked accordingly |
| `track announce [player]` | Broadcast what is tracked — to all players by default, or privately to one |

Commands are silently cancelled from chat — other players will not see them.

### Enabling Beta APIs

**Option A — In-game:** Open world settings → Experiments → enable Beta APIs, then restart.

**Option B — level.dat:** Set `experiments.gametest = 1` in the world's `level.dat` file.

Without Beta APIs, all tracking and alerts continue to work normally. Only the operator chat commands are unavailable.

> **Note:** The ignored player list and event log are session-only. They reset on server restart.

## License

MIT
