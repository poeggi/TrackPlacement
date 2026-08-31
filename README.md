# TrackPlacement

A server-side Bedrock Dedicated Server (BDS) behavior pack that monitors placement and use of dangerous items and blocks. Alerts are broadcast in-game to all online players and logged to the server console. No cheats required! No client-side installation or downloads needed. Works with vanilla Bedrock (1.21+).

## Features

- Tracks block placements (TNT, Respawn Anchor, End Crystal, and more)
- Tracks items loaded into dispensers, droppers, and hoppers (automation chain detection)
- Tracks items held when interacting with entities (TNT minecarts)
- Tracks items acquired via crafting or pickup
- Detects entities fired from dispensers/droppers
- Dimension-aware tracking - e.g. beds can be restricted to Nether/The End only
- Rate-limiting with configurable windows - bursts are summarised rather than spammed
- Nearby events are clustered by location to reduce noise
- All events logged to console regardless of in-game alert settings
- Operator commands via chat (auto-detected at startup; currently requires Beta APIs on the world)

## Requirements

- Minecraft Bedrock Dedicated Server 1.21.0 or later
- `@minecraft/server` API version 2.1.0 (stable, no experiments required for core log-based tracking)
- Operator chat commands require the `chatSend` API — as of BDS 1.26.20.5 this means enabling Beta APIs on the world. If a future BDS version exposes this API without Beta APIs, commands will activate automatically with no changes needed.
- **Warning:** Enabling Beta APIs disables world achievements permanently. Only enable it if you accept this trade-off.

## Installation

1. Copy `TrackPlacement_BP/` into your server's central `behavior_packs/` directory.

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
    ├── main.js              - core tracking logic and operator commands
    └── tracked_blocks.js    - **configuration**: what to track and how to notify
```

## Configuration

All tracking is **configured** in `scripts/tracked_blocks.js`. Edit this file to add, remove, or adjust tracked items. Changes take effect on server restart.

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
| `HOP_LOAD` | Player loads a tracked item into a hopper |
| `DROP_LOAD` | Player loads a tracked item into a dropper |
| `DISP_LOAD` | Player loads a tracked item into a dispenser |
| `ENTITY` | Player interacts with a tracked entity while holding a tracked item |
| `PICKUP` | Tracked item added to a player's inventory via craft or pickup |
| `DISP_FIRE` | Tracked entity spawned adjacent to a dispenser or dropper |

## Console log format

```
[TrackPlacement] [PLACE] PiCraft3 | TNT (tnt) | (-240, 136, 74) | Overworld | #1
[TrackPlacement] [PLACE x3 +more] PiCraft3 | TNT (tnt) | near (-240, 136, 74) (x3) | Overworld | #4
[TrackPlacement] [DISP_LOAD] PiCraft3 | TNT (tnt) | (-240, 136, 74) | Overworld | #5
[TrackPlacement] [DISP_FIRE] _dispenser | TNT (tnt) | (-240, 136, 74) | Overworld | #6
```

## Operator commands

Chat commands require the `chatSend` API, which is detected automatically at startup. As of BDS 1.26.20.5 (@minecraft/server 2.7.0, May 2026) this API requires **Beta APIs** enabled on the world. If a future BDS version makes it available without Beta APIs, commands will activate automatically — no code changes needed.

Type the following directly in chat (press `t` or `/`):

| Command | Description |
|---|---|
| `track help` | Show all commands |
| `track ignore add <player>` | Ignore a player's activity this session |
| `track ignore remove <player>` | Remove a player's ignore |
| `track ignore list` | List all currently ignored players, including who set them and when |
| `track offenders [count]` | Show last N tracked events (default: 3). Includes ignored players, marked accordingly |
| `track announce [player]` | Broadcast what is tracked - to all players by default, or privately to one |

Commands are silently cancelled from chat - other players will not see them.

### Enabling Beta APIs

> **Warning:** Enabling Beta APIs permanently disables achievements for that world. Only do this if you accept that trade-off.

**Option A - In-game:** Open world settings → Experiments → enable Beta APIs, then restart.

**Option B - level.dat:** Set `experiments.gametest = 1` in the world's `level.dat` file.

Without Beta APIs, all tracking and alerts continue to work normally. Only the operator chat commands are unavailable.

> **Note:** The ignored player list and event log are session-only. They reset on server restart.

## License

TrackPlacement is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

The full license text is in [LICENSE](LICENSE), or online at
<https://www.gnu.org/licenses/agpl-3.0.html>.

SPDX-License-Identifier: `AGPL-3.0-or-later`
