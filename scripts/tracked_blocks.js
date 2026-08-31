// TrackPlacement - Bedrock Dedicated Server behavior pack
// Copyright (C) 2026 poeggi
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. It is distributed WITHOUT ANY WARRANTY; see the license for
// details. You should have received a copy of the license along with this
// program. If not, see <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// TrackPlacement configuration
//
// Common fields for tracked_blocks and tracked_items:
//   id           — Minecraft block/item/entity type ID
//   label        — display name used in alerts
//   alert_color  — chat color code: \u00a7c red  \u00a76 gold  \u00a7e yellow  \u00a7d purple  \u00a7b cyan  \u00a7a green
//   window_ticks — rate-limit window in ticks (20 = 1s). 0 = alert every occurrence immediately.
//   dimensions   — optional array of dimension IDs to restrict tracking to.
//                  omit to track in all dimensions.
//                  valid values: "minecraft:overworld"  "minecraft:nether"  "minecraft:the_end"
//
// chat_alerts — broadcast tracked events in public chat to all online players.
//               set to false to log only to console.

export const chat_alerts = true;

export const tracked_blocks = [
    { id: "minecraft:tnt",            label: "TNT",            alert_color: "\u00a7c", window_ticks: 200 },
    { id: "minecraft:respawn_anchor", label: "Resp. Anchor",   alert_color: "\u00a7d", window_ticks: 0 },
    { id: "minecraft:end_crystal",    label: "End Crystal",    alert_color: "\u00a7b", window_ticks: 0 },
    // Beds explode in the Nether and The End. Uncomment to track them there only:
    // { id: "minecraft:white_bed",      label: "Bed (White)",    alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:orange_bed",     label: "Bed (Orange)",   alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:magenta_bed",    label: "Bed (Magenta)",  alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:light_blue_bed", label: "Bed (Lt Blue)",  alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:yellow_bed",     label: "Bed (Yellow)",   alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:lime_bed",       label: "Bed (Lime)",     alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:pink_bed",       label: "Bed (Pink)",     alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:gray_bed",       label: "Bed (Gray)",     alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:light_gray_bed", label: "Bed (Lt Gray)",  alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:cyan_bed",       label: "Bed (Cyan)",     alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:purple_bed",     label: "Bed (Purple)",   alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:blue_bed",       label: "Bed (Blue)",     alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:brown_bed",      label: "Bed (Brown)",    alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:green_bed",      label: "Bed (Green)",    alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:red_bed",        label: "Bed (Red)",      alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
    // { id: "minecraft:black_bed",      label: "Bed (Black)",    alert_color: "\u00a7e", window_ticks: 0, dimensions: ["minecraft:nether", "minecraft:the_end"] },
];

export const tracked_items = [
    { id: "minecraft:tnt",             label: "TNT",          alert_color: "\u00a7c", window_ticks: 200 },
    { id: "minecraft:tnt_minecart",    label: "TNT Minecart", alert_color: "\u00a76", window_ticks: 0 },
    { id: "minecraft:end_crystal",     label: "End Crystal",  alert_color: "\u00a7b", window_ticks: 0 },
    { id: "minecraft:respawn_anchor",  label: "Resp. Anchor", alert_color: "\u00a7d", window_ticks: 0 },
    { id: "minecraft:firework_rocket", label: "Firework",     alert_color: "\u00a7e", window_ticks: 200 },
];

export const tracked_containers = [
    { id: "minecraft:dispenser" },
    { id: "minecraft:dropper"   },
    { id: "minecraft:hopper"    },
];

export const tracked_entity_interactions = [
    { id: "minecraft:minecart" },
];

export const dispenser_entities = [
    { id: "minecraft:tnt_minecart" },
    { id: "minecraft:tnt"          },
    { id: "minecraft:arrow"        },
    { id: "minecraft:fireball"     },
];
