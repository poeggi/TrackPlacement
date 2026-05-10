import { world, system } from "@minecraft/server";

// --------------------------------------------------------------------------
// TrackPlacement - Bedrock Dedicated Server behavior pack
// UUID: 560fee0a-73c1-4f03-9c27-3ae8ba58344a
//
// (Optional) chat-based operator commands require the chatSend API.
// As of BDS 1.26.20.5 (@minecraft/server 2.7.0, May 2026) this requires Beta APIs
// enabled on the world. Later versions may expose it without Beta APIs — availability
// is detected automatically at startup, no code changes needed.
// When available, commands are typed in chat (t or /) by operators:
//
//   track help
//   track ignore add <player>
//   track ignore remove <player>
//   track ignore list
//   track offenders [count]
//   track announce [player]
//
// To enable Beta APIs (required for chat commands):
//   Option A - In-game: world settings -> Experiments -> Beta APIs -> ON
//   Option B - level.dat: set experiments.gametest = 1
//
// Even without Beta APIs, tracking and alerts still work fully.
// Only the operator chat commands are unavailable.
//
// Alert tags (as used in logs):
//   [PLACE]      - tracked block placed directly in world
//   [PICKUP]     - tracked item acquired via craft or pickup
//   [ENTITY]     - tracked item held when interacting with entity
//   [HOP_LOAD]   - tracked item placed into hopper by player
//   [DROP_LOAD]  - tracked item placed into dropper by player
//   [DISP_LOAD]  - tracked item placed into dispenser by player
//   [DISP_FIRE]  - tracked entity spawned from dispenser or dropper
// --------------------------------------------------------------------------

const FALLBACK_BLOCKS      = [{ id: "minecraft:tnt", label: "TNT", alert_color: "\u00a7c" }];
const DEFAULT_WINDOW_TICKS = 200;
const MAX_EVENT_LOG        = 1000; // max events kept in memory per server session
const CLUSTER_RADIUS       = 8;
const DISPENSER_ACTOR      = "_dispenser";
const SESSION_MAX_TICKS    = 12000; // 10 minutes
const SESSION_SNAP_TICKS   = 20;   // snapshot interval - 1 second
const SESSION_CLOSE_DIST   = 6;    // blocks - player walked away
const DISPENSER_CACHE_TICKS = 1200; // 1 minute - how long a verified dispenser position is trusted

// Container typeId -> alert tag
const CONTAINER_TAGS = {
    "minecraft:hopper":    "HOP_LOAD",
    "minecraft:dropper":   "DROP_LOAD",
    "minecraft:dispenser": "DISP_LOAD",
};

let blockMap           = null;
let itemMap            = null;
let containerSet       = null;
let entitySet          = null;
let dispenserEntities  = null;
let chatAlertsEnabled  = true;
let chatCommandsActive = false;

// eventLog entries: {type, actor, id, label, coords: {x,y,z}|null, dimId, wasIgnored}
// Capped at MAX_EVENT_LOG entries (oldest discarded first).
const eventLog       = [];
// eventCounts: "actor\0type\0itemId" -> monotonically increasing count.
// Kept separate from eventLog so the #N counter never resets when the log caps.
const eventCounts    = {};
// ignoredPlayers map: player name -> {by, time}
const ignoredPlayers = new Map();
// windows: actor -> { [type:itemId]: { coords: ({x,y,z}|null)[], total, timerId } }
// Open rate-limit windows — accumulate burst events until the window timer fires.
const windows        = {};
// recentlyRemovedItems: playerName -> Set<typeId>
// Tracks tracked items removed from inventory within the last 2 ticks. Used to
// suppress the paired "added" event that Bedrock fires when a player moves an
// item between inventory slots (slot moves emit "removed" + "added" for the same item).
const recentlyRemovedItems = new Map();

// containerSessions: playerName -> {
//   blockTypeId, blockPos, dimId,
//   intervalId, timeoutId
// }
const containerSessions = new Map();
// dispenserCache: "dimId|x|y|z" -> expiry tick
// Caches verified dispenser/dropper positions to avoid 6 getBlock() calls per entity spawn.
const dispenserCache = new Map();

// --------------------------------------------------------------------------
// Config load
// --------------------------------------------------------------------------

async function loadConfig() {
    try {
        const cfg = await import("./tracked_blocks.js");
        const toEntry = e => [e.id, {
            label:        e.label ?? stripNamespace(e.id),
            alert_color:  e.alert_color,
            window_ticks: e.window_ticks ?? DEFAULT_WINDOW_TICKS,
            dimensions:   e.dimensions ?? null,
        }];
        blockMap          = new Map((cfg.tracked_blocks ?? FALLBACK_BLOCKS).map(toEntry));
        itemMap           = new Map((cfg.tracked_items ?? []).map(toEntry));
        containerSet      = new Set((cfg.tracked_containers ?? []).map(e => e.id));
        entitySet         = new Set((cfg.tracked_entity_interactions ?? []).map(e => e.id));
        dispenserEntities = new Set((cfg.dispenser_entities ?? []).map(e => e.id));
        chatAlertsEnabled = cfg.chat_alerts !== false;
        // Warn about any config IDs that don't look like valid namespaced identifiers.
        for (const id of [...blockMap.keys(), ...itemMap.keys(), ...containerSet, ...entitySet, ...dispenserEntities]) {
            if (!id || !id.includes(":")) {
                console.warn("[TrackPlacement] WARNING: Config ID '" + id + "' looks invalid - expected 'namespace:name' format (e.g. 'minecraft:tnt'). It will not match any in-game block or item.");
            }
        }
        console.log("[TrackPlacement] Config loaded - blocks: " + blockMap.size + ", items: " + itemMap.size + ", containers: " + containerSet.size + ", entities: " + entitySet.size + ", dispenser entities: " + dispenserEntities.size + ", chat alerts: " + chatAlertsEnabled);
    } catch (err) {
        console.log("[TrackPlacement] Could not load config (" + err + "), falling back to TNT only.");
        blockMap          = new Map(FALLBACK_BLOCKS.map(e => [e.id, { label: e.label, alert_color: e.alert_color, window_ticks: DEFAULT_WINDOW_TICKS, dimensions: null }]));
        itemMap           = new Map();
        containerSet      = new Set();
        entitySet         = new Set();
        dispenserEntities = new Set();
        chatAlertsEnabled = true;
    }
}

// --------------------------------------------------------------------------
// Utility functions
// --------------------------------------------------------------------------

function stripNamespace(id) {
    return id.replace("minecraft:", "");
}

function formatCoords(loc) {
    return "(" + Math.floor(loc.x) + ", " + Math.floor(loc.y) + ", " + Math.floor(loc.z) + ")";
}

function dist3d(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function inAllowedDimension(meta, dimId) {
    return !meta.dimensions || meta.dimensions.includes(dimId);
}

function currentTimestamp() {
    return new Date().toISOString().replace("T", " ").substring(0, 19);
}

const DIMENSION_INFO = {
    "minecraft:overworld": { name: "Overworld", color: "\u00a7a" },
    "minecraft:nether":    { name: "Nether",    color: "\u00a7c" },
    "minecraft:the_end":   { name: "The End",   color: "\u00a7b" },
};

function dimName(dimId) {
    return (DIMENSION_INFO[dimId] ?? { name: dimId }).name;
}

function dimColored(dimId) {
    const d = DIMENSION_INFO[dimId] ?? { name: dimId, color: "\u00a7f" };
    return d.color + d.name + "\u00a7r";
}

// coordList is an array of {x,y,z}|null. null entries (unknown location) form
// their own singleton cluster so they still appear in output.
function clusterCoords(coordList) {
    const clusters = [];
    for (const coord of coordList) {
        const match = coord && clusters.find(c => c.anchor && dist3d(c.anchor, coord) <= CLUSTER_RADIUS);
        if (match) {
            match.count++;
        } else {
            clusters.push({ anchor: coord, count: 1 });
        }
    }
    return clusters;
}

function formatClusters(clusters, coordColor, plain) {
    return clusters.map(c => {
        const prefix    = c.count > 1 ? "near " : "";
        const anchorStr = c.anchor ? formatCoords(c.anchor) : "(unknown)";
        const loc = plain
            ? prefix + anchorStr
            : prefix + coordColor + anchorStr + "\u00a7r";
        return c.count > 1 ? loc + " (x" + c.count + ")" : loc;
    }).join(", ");
}

function countPreviousEvents(actor, type, itemId) {
    const key = actor + "\0" + type + "\0" + itemId;
    return (eventCounts[key] = (eventCounts[key] ?? 0) + 1);
}

// --------------------------------------------------------------------------
// Rate-limit window functions
// --------------------------------------------------------------------------

function getWindow(actor, key) {
    return (windows[actor] ?? {})[key] ?? null;
}

function setWindow(actor, key, value) {
    if (!windows[actor]) windows[actor] = {};
    windows[actor][key] = value;
}

function clearWindow(actor, key) {
    if (windows[actor]) delete windows[actor][key];
}

// --------------------------------------------------------------------------
// Output functions
// --------------------------------------------------------------------------

function logEntry(type, actor, label, itemId, clusters, dimension, total) {
    const count   = clusters.reduce((s, c) => s + c.count, 0);
    const typeTag = count > 1 ? type + " x" + count : type;
    const locStr  = formatClusters(clusters, "", true);
    console.log("[TrackPlacement] [" + typeTag + "] " + actor + " | " + label + " (" + stripNamespace(itemId) + ") | " + locStr + " | " + dimension + " | #" + total);
}
function broadcastAlert(type, actor, label, itemId, clusters, dimId, color, total) {
    if (!chatAlertsEnabled) return;
    const count   = clusters.reduce((s, c) => s + c.count, 0);
    const typeTag = count > 1 ? type + " x" + count : type;
    const locStr  = formatClusters(clusters, "\u00a7b", false);
    const msg     = color + "\u00a7l[" + typeTag + "]\u00a7r \u00a7e" + actor + "\u00a7r | " + color + label + " (" + stripNamespace(itemId) + ")\u00a7r | " + locStr + " | " + dimColored(dimId) + " | \u00a77#" + total + "\u00a7r";
    for (const p of world.getAllPlayers()) p.sendMessage(msg);
}

// Always record to eventLog (capped at MAX_EVENT_LOG). Ignored players are logged
// with wasIgnored=true but do not trigger console output or chat alerts.
// coords is a {x,y,z} object or null if the location was unavailable.
function fireAlert(type, actor, label, itemId, coords, dimId, color, windowTicks) {
    const isIgnored = ignoredPlayers.has(actor);
    const total     = countPreviousEvents(actor, type, itemId);
    eventLog.push({ type, actor, id: itemId, label, coords, dimId, wasIgnored: isIgnored });
    if (eventLog.length > MAX_EVENT_LOG) eventLog.shift();
    if (isIgnored) return;
    const key = type + ":" + itemId;
    const win = getWindow(actor, key);
    if (!win) {
        const firstClusters = clusterCoords([coords]);
        logEntry(type, actor, label, itemId, firstClusters, dimName(dimId), total);
        system.run(() => broadcastAlert(type, actor, label, itemId, firstClusters, dimId, color, total));
        const timerId = system.runTimeout(() => {
            const w = getWindow(actor, key);
            if (!w || w.coords.length <= 1) { clearWindow(actor, key); return; }
            const summaryClusters = clusterCoords(w.coords.slice(1));
            logEntry(type + " +more", actor, label, itemId, summaryClusters, dimName(dimId), w.total);
            system.run(() => broadcastAlert(type + " +more", actor, label, itemId, summaryClusters, dimId, color, w.total));
            clearWindow(actor, key);
        // windowTicks=0 means "no clustering window"; use 1 tick as the minimum
        // valid runTimeout value. The first alert already fired immediately above,
        // so this timeout only handles any burst events that sneak in within that
        // single tick — in practice the summary will be skipped (coords.length <= 1).
        }, windowTicks > 0 ? windowTicks : 1);
        setWindow(actor, key, { coords: [coords], total, timerId });
    } else {
        win.coords.push(coords);
        win.total = total;
    }
}

function fireDispenserAlert(label, itemId, coords, dimId, color, windowTicks) {
    fireAlert("DISP_FIRE", DISPENSER_ACTOR, label, itemId, coords, dimId, color, windowTicks);
}

// --------------------------------------------------------------------------
// Container session - snapshot-based detection
//
// When a player opens a tracked container:
//   1. Snapshot the container inventory immediately.
//   2. Every SESSION_SNAP_TICKS (1s), snapshot again and diff.
//      Fire an alert for any tracked item that appeared since last snap.
//   3. Each interval, check if the player has moved > SESSION_CLOSE_DIST
//      blocks from the container. If so, end the session.
//   4. Hard cap at SESSION_MAX_TICKS (Default: 10 minutes).
//   5. Also ended on playerLeave.
// --------------------------------------------------------------------------

function snapshotInventory(block) {
    const snap = new Map();
    try {
        const inv = block.getComponent("inventory");
        if (!inv || !inv.container) return snap;
        const container = inv.container;
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (!item) continue;
            snap.set(item.typeId, (snap.get(item.typeId) ?? 0) + item.amount);
        }
    } catch { /* block may have been removed */ }
    return snap;
}

function diffSnapshots(before, after) {
    const added = new Map();
    for (const [typeId, countAfter] of after) {
        const countBefore = before.get(typeId) ?? 0;
        if (countAfter > countBefore) added.set(typeId, countAfter - countBefore);
    }
    return added;
}

function endContainerSession(playerName) {
    const session = containerSessions.get(playerName);
    if (!session) return;
    system.clearRun(session.intervalId);
    system.clearRun(session.timeoutId);
    containerSessions.delete(playerName);
}

function startContainerSession(player, block, dimension) {
    // Only one container is tracked per player at a time. Opening a second
    // container while one is active silently ends the first session.
    endContainerSession(player.name);
    const blockPos    = { x: block.location.x, y: block.location.y, z: block.location.z };
    const blockTypeId = block.typeId;
    const dimId       = dimension.id;
    const alertTag    = CONTAINER_TAGS[blockTypeId] ?? "CONT_LOAD";
    let lastSnap      = snapshotInventory(block);
    const intervalId  = system.runInterval(() => {
        const session = containerSessions.get(player.name);
        if (!session) return;
        try {
            const playerPos = player.location;
            if (player.dimension.id !== dimId || dist3d(playerPos, blockPos) > SESSION_CLOSE_DIST) {
                endContainerSession(player.name);
                return;
            }
        } catch {
            endContainerSession(player.name);
            return;
        }
        let currentSnap;
        try {
            const liveBlock = dimension.getBlock(blockPos);
            if (!liveBlock || liveBlock.typeId !== blockTypeId) {
                endContainerSession(player.name);
                return;
            }
            currentSnap = snapshotInventory(liveBlock);
        } catch {
            endContainerSession(player.name);
            return;
        }
        const added = diffSnapshots(lastSnap, currentSnap);
        lastSnap = currentSnap;
        for (const [typeId, countAdded] of added) {
            if (!itemMap.has(typeId)) continue;
            const meta = itemMap.get(typeId);
            if (!inAllowedDimension(meta, dimId)) continue;
            for (let i = 0; i < countAdded; i++) {
                fireAlert(alertTag, player.name, meta.label, typeId, blockPos, dimId, meta.alert_color, meta.window_ticks);
            }
        }
    }, SESSION_SNAP_TICKS);
    const timeoutId = system.runTimeout(() => {
        endContainerSession(player.name);
    }, SESSION_MAX_TICKS);
    containerSessions.set(player.name, { blockTypeId, blockPos, dimId, intervalId, timeoutId });
}

// --------------------------------------------------------------------------
// Operator command related functions
// NOTE: Requires Beta APIs. Registered only if detected at startup.
// Uses beforeEvents.chatSend to cancel the message so it stays silent.
// --------------------------------------------------------------------------

function sendMsg(target, msg) {
    target.sendMessage("\u00a7e[TrackPlacement]\u00a7r " + msg);
}

function cmdHelp(sender) {
    sendMsg(sender, "Commands (operators only):");
    sender.sendMessage("  \u00a77track ignore add \u00a7f<player>    \u00a7r\u2014 ignore a player this session");
    sender.sendMessage("  \u00a77track ignore remove \u00a7f<player> \u00a7r\u2014 remove a player's ignore");
    sender.sendMessage("  \u00a77track ignore list              \u00a7r\u2014 show all ignored players");
    sender.sendMessage("  \u00a77track offenders \u00a7f[count]        \u00a7r\u2014 show last tracked events (default: 3)");
    sender.sendMessage("  \u00a77track announce \u00a7f[player]        \u00a7r\u2014 warn about tracked items (default: all players)");
    sender.sendMessage("  \u00a77track help                     \u00a7r\u2014 show this message");
}

function cmdIgnore(sender, action, target) {
    if (action === "add" && target) {
        ignoredPlayers.set(target, { by: sender.name, time: currentTimestamp() });
        sendMsg(sender, "\u00a7f" + target + "\u00a7r is now ignored this session.");
        console.log("[TrackPlacement] " + sender.name + " ignored " + target + ".");
    } else if (action === "remove" && target) {
        ignoredPlayers.delete(target);
        sendMsg(sender, "\u00a7f" + target + "\u00a7r is no longer ignored.");
        console.log("[TrackPlacement] " + sender.name + " removed ignore for " + target + ".");
    } else if (action === "list") {
        if (ignoredPlayers.size === 0) {
            sendMsg(sender, "No players are currently ignored.");
        } else {
            sendMsg(sender, "Currently ignored (" + ignoredPlayers.size + "):");
            for (const [player, info] of ignoredPlayers) {
                sender.sendMessage("  \u00a7f" + player + "\u00a7r \u2014 by \u00a7e" + info.by + "\u00a7r at " + info.time);
            }
        }
    } else {
        sendMsg(sender, "Usage: track ignore add <player> | remove <player> | list");
    }
}

function cmdOffenders(sender, countArg) {
    const n      = Math.max(1, parseInt(countArg) || 3);
    const recent = eventLog.slice(-n).reverse();
    if (recent.length === 0) {
        sendMsg(sender, "No events recorded this session.");
        return;
    }
    sendMsg(sender, "Last " + recent.length + " event(s):");
    recent.forEach((e, i) => {
        const actor      = e.actor === DISPENSER_ACTOR ? "Dispenser" : e.actor;
        const ignoredTag = e.wasIgnored ? " \u00a77(ignored, not alerted)\u00a7r" : "";
        const coordStr   = e.coords ? formatCoords(e.coords) : "(unknown)";
        sender.sendMessage("  \u00a77#" + (i + 1) + " \u00a7e" + actor + "\u00a7r | \u00a7f" + e.label + "\u00a7r | \u00a7b" + coordStr + "\u00a7r | " + dimColored(e.dimId) + " | \u00a77" + e.type + "\u00a7r" + ignoredTag);
    });
}

function cmdAnnounce(sender, targetName) {
    const recipients = targetName
        ? world.getAllPlayers().filter(p => p.name === targetName)
        : world.getAllPlayers();
    if (targetName && recipients.length === 0) {
        sendMsg(sender, "Player \u00a7f" + targetName + "\u00a7r is not online.");
        return;
    }
    const blockLabels     = [...blockMap.values()].map(v => v.label).join(", ") || "none";
    const itemLabels      = [...itemMap.values()].map(v => v.label).join(", ") || "none";
    const containerLabels = [...containerSet].map(id => stripNamespace(id)).join(", ") || "none";
    const dispenserLabels = [...dispenserEntities].map(id => stripNamespace(id)).join(", ") || "none";
    for (const p of recipients) {
        p.sendMessage("\u00a7c\u00a7l[TrackPlacement]\u00a7r \u00a7cWarning: This server monitors placement of dangerous items and blocks.");
        p.sendMessage("  \u00a77Blocks: \u00a7f"             + blockLabels);
        p.sendMessage("  \u00a77Items: \u00a7f"              + itemLabels);
        p.sendMessage("  \u00a77Containers: \u00a7f"         + containerLabels);
        p.sendMessage("  \u00a77Dispenser entities: \u00a7f" + dispenserLabels);
        p.sendMessage("  \u00a7cAll placement activity is logged and reviewed by server operators.");
        if (chatCommandsActive) {
            p.sendMessage("  \u00a77Operators: type \u00a7ftrack help\u00a7r in chat for commands.");
        }
    }
    console.log("[TrackPlacement] " + sender.name + " sent announce to " + (targetName ?? "all players") + ".");
}
function handleCommand(sender, message) {
    const parts = message.trim().split(/\s+/);
    if (!sender.isOp) {
        sendMsg(sender, "You must be an operator to use these commands.");
        return;
    }
    const sub = parts[1];
    if (!sub || sub === "help") {
        cmdHelp(sender);
    } else if (sub === "ignore") {
        cmdIgnore(sender, parts[2], parts[3]);
    } else if (sub === "offenders") {
        cmdOffenders(sender, parts[2]);
    } else if (sub === "announce") {
        cmdAnnounce(sender, parts[2]);
    } else {
        sendMsg(sender, "Unknown command. Type \u00a7ftrack help\u00a7r for a list of commands.");
    }
}

// Attempt to register chat commands using beforeEvents.chatSend (Beta APIs only).
// If the API is unavailable, logs a notice and leaves commands inactive.
function tryRegisterChatCommands() {
    try {
        if (!world.beforeEvents || typeof world.beforeEvents.chatSend?.subscribe !== "function") {
            throw new Error("chatSend not available");
        }
        const VALID_SUBS = new Set(["help", "ignore", "offenders", "announce"]);
        world.beforeEvents.chatSend.subscribe((event) => {
            // Only intercept "track <valid-subcommand>" to avoid silently swallowing
            // legitimate chat that happens to start with the word "track".
            const parts = event.message.trim().split(/\s+/);
            if (parts[0] !== "track") return;
            if (parts.length > 1 && !VALID_SUBS.has(parts[1])) return;
            event.cancel = true;
            const sender  = event.sender;
            const message = event.message;
            system.run(() => handleCommand(sender, message));
        });
        chatCommandsActive = true;
        console.log("[TrackPlacement] Chat commands active (chatSend API available). Type 'track help' in chat.");
    } catch (e) {
        chatCommandsActive = false;
        console.log("[TrackPlacement] Chat commands inactive (chatSend API unavailable). On current BDS versions, enable Beta APIs on this world to activate them.");
    }
}

// --------------------------------------------------------------------------
// Event listeners
// --------------------------------------------------------------------------

function registerListeners() {
    // Block placements
    world.afterEvents.playerPlaceBlock.subscribe((event) => {
        let blockTypeId, playerName, dimId, coords;
        try { blockTypeId = event.block.typeId;                                                       } catch { return; } // can't identify block - nothing to alert
        if (!blockMap.has(blockTypeId)) return;
        const meta = blockMap.get(blockTypeId);
        try { playerName = event.player.name;                                                         } catch { playerName = "(unknown)"; }
        try { dimId      = event.dimension.id;                                                        } catch { dimId      = "unknown"; }
        try { const l = event.block.location; coords = { x: l.x, y: l.y, z: l.z };                  } catch { coords = null; }
        if (dimId !== "unknown" && !inAllowedDimension(meta, dimId)) return;
        fireAlert("PLACE", playerName, meta.label, blockTypeId, coords, dimId, meta.alert_color, meta.window_ticks);
    });
    // Container sessions - player opens a tracked container
    world.afterEvents.playerInteractWithBlock.subscribe((event) => {
        const { block, player } = event;
        const dimension = event.dimension ?? player?.dimension;
        if (!block || !dimension || !containerSet.has(block.typeId)) return;
        startContainerSession(player, block, dimension);
    });
    // Entity interactions - tracked item held while interacting
    world.afterEvents.playerInteractWithEntity.subscribe((event) => {
        let playerName, dimId, targetTypeId, itemTypeId, coords;
        try { itemTypeId   = event.itemStack?.typeId;                                                } catch { return; } // no item - nothing to alert
        if (!itemTypeId || !itemMap.has(itemTypeId)) return;
        try { targetTypeId = event.target.typeId;                                                    } catch { targetTypeId = "(unknown)"; }
        try { playerName   = event.player.name;                                                      } catch { playerName   = "(unknown)"; }
        try { dimId        = (event.dimension ?? event.player?.dimension)?.id;                       } catch { dimId        = "unknown"; }
        try { const l = event.target.location; coords = { x: l.x, y: l.y, z: l.z };                } catch { coords = null; }
        // Alert if interacting with a configured entity, or with any entity whose type
        // could not be read (targetTypeId = "(unknown)") — better a false positive than
        // a missed alert caused by a transient API failure.
        if (targetTypeId !== "(unknown)" && !entitySet.has(targetTypeId)) return;
        const meta = itemMap.get(itemTypeId);
        if (dimId !== "unknown" && !inAllowedDimension(meta, dimId)) return;
        fireAlert("ENTITY", playerName, meta.label, itemTypeId, coords, dimId, meta.alert_color, meta.window_ticks);
    });
    // Craft / pickup — watches both "removed" and "added" change types.
    // Bedrock fires "removed" + "added" for the same item when a player moves it
    // between inventory slots. We suppress the "added" alert in that case by
    // recording the "removed" event in recentlyRemovedItems and checking it when
    // the paired "added" arrives (both events fire within the same tick or the next).
    world.afterEvents.playerInventoryItemChange.subscribe((event) => {
        const { player, itemStack, changeType } = event;
        if (!itemStack || !itemMap.has(itemStack.typeId)) return;
        const typeId = itemStack.typeId;
        let playerName;
        try { playerName = player.name; } catch { playerName = null; }
        if (changeType === "removed") {
            if (playerName) {
                if (!recentlyRemovedItems.has(playerName)) recentlyRemovedItems.set(playerName, new Set());
                recentlyRemovedItems.get(playerName).add(typeId);
                // Clear after 2 ticks — enough time for the paired "added" to fire.
                system.runTimeout(() => {
                    const s = recentlyRemovedItems.get(playerName);
                    if (s) { s.delete(typeId); if (s.size === 0) recentlyRemovedItems.delete(playerName); }
                }, 2);
            }
            return;
        }
        if (changeType !== "added") return;
        // Skip if a matching "removed" was seen this tick — item was only moved between slots.
        if (playerName && recentlyRemovedItems.get(playerName)?.has(typeId)) return;
        const meta = itemMap.get(typeId);
        let dimId, coords;
        try { dimId = player.dimension.id;                                      } catch { dimId   = "unknown"; }
        try { const l = player.location; coords = { x: l.x, y: l.y, z: l.z }; } catch { coords  = null; }
        if (dimId !== "unknown" && !inAllowedDimension(meta, dimId)) return;
        fireAlert("PICKUP", playerName ?? "(unknown)", meta.label, typeId, coords, dimId, meta.alert_color, meta.window_ticks);
    });
    // Dispenser / dropper fires tracked entity
    world.afterEvents.entitySpawn.subscribe((event) => {
        const entity = event.entity;
        if (!entity || !entity.typeId || !dispenserEntities.has(entity.typeId)) return;
        const typeId = entity.typeId;
        const meta   = itemMap.has(typeId)
            ? itemMap.get(typeId)
            : { label: stripNamespace(typeId), alert_color: "\u00a76", window_ticks: DEFAULT_WINDOW_TICKS, dimensions: null };
        let coords, dimId;
        try {
            const l = entity.location;
            coords = { x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) };
            dimId  = entity.dimension.id;
        } catch {
            // Entity invalidated before location could be read - fire alert without coordinates
            fireDispenserAlert(meta.label, typeId, null, "unknown", meta.alert_color, meta.window_ticks);
            return;
        }
        const offsets = [{x:1,y:0,z:0},{x:-1,y:0,z:0},{x:0,y:0,z:1},{x:0,y:0,z:-1},{x:0,y:1,z:0},{x:0,y:-1,z:0}];
        let dim;
        try { dim = world.getDimension(dimId); } catch { dim = null; }
        if (!dim) {
            // Can't verify dispenser source but we know a tracked entity spawned - alert anyway
            fireDispenserAlert(meta.label, typeId, coords, dimId, meta.alert_color, meta.window_ticks);
            return;
        }
        const now = system.currentTick;
        // Fast path: check if any neighbor is a cached/known dispenser position.
        let cachedNeighbor = null;
        for (const o of offsets) {
            const nx = coords.x + o.x, ny = coords.y + o.y, nz = coords.z + o.z;
            const key = dimId + "|" + nx + "|" + ny + "|" + nz;
            const expiry = dispenserCache.get(key);
            if (expiry !== undefined) {
                if (now <= expiry) { cachedNeighbor = { key, pos: { x: nx, y: ny, z: nz } }; break; }
                dispenserCache.delete(key);
            }
        }
        if (cachedNeighbor !== null) {
            // Re-validate with a single getBlock() call before trusting the cache.
            let stillValid = false;
            try {
                const b = dim.getBlock(cachedNeighbor.pos);
                stillValid = b && (b.typeId === "minecraft:dispenser" || b.typeId === "minecraft:dropper");
            } catch { /* ignore */ }
            if (stillValid) {
                dispenserCache.set(cachedNeighbor.key, now + DISPENSER_CACHE_TICKS);
                fireDispenserAlert(meta.label, typeId, coords, dimId, meta.alert_color, meta.window_ticks);
                return;
            }
            dispenserCache.delete(cachedNeighbor.key);
            // Fall through to full 6-block check below.
        }
        // Full check: scan all 6 neighbors. Cache the position if a dispenser is found.
        let foundKey = null;
        const fromDispenser = offsets.some(o => {
            const nx = coords.x + o.x, ny = coords.y + o.y, nz = coords.z + o.z;
            try {
                const b = dim.getBlock({ x: nx, y: ny, z: nz });
                if (b && (b.typeId === "minecraft:dispenser" || b.typeId === "minecraft:dropper")) {
                    foundKey = dimId + "|" + nx + "|" + ny + "|" + nz;
                    return true;
                }
            } catch { return false; }
            return false;
        });
        if (!fromDispenser) return;
        if (foundKey) dispenserCache.set(foundKey, now + DISPENSER_CACHE_TICKS);
        fireDispenserAlert(meta.label, typeId, coords, dimId, meta.alert_color, meta.window_ticks);
    });
    // Periodically evict expired dispenser cache entries.
    system.runInterval(() => {
        const now = system.currentTick;
        for (const [key, expiry] of dispenserCache) {
            if (now > expiry) dispenserCache.delete(key);
        }
    }, 1200);
    // Clean up all per-player state on disconnect
    world.afterEvents.playerLeave.subscribe((event) => {
        endContainerSession(event.playerName);
        delete windows[event.playerName];
        recentlyRemovedItems.delete(event.playerName);
    });
    tryRegisterChatCommands();
}

// --------------------------------------------------------------------------
// Startup (main)
// --------------------------------------------------------------------------

loadConfig().then(() => {
    system.run(() => {
        registerListeners();
        const tracked = [...blockMap.entries()].map(([id, v]) => v.label + " (" + stripNamespace(id) + ")").join(", ");
        console.log("[TrackPlacement] Active. Tracking: " + tracked);
        const online = world.getAllPlayers();
        if (online.length > 0) {
            for (const p of online) {
                p.sendMessage("\u00a7a[TrackPlacement] \u00a7rPlacement monitoring is \u00a72active\u00a7r.");
                if (p.isOp && chatCommandsActive) {
                    p.sendMessage("\u00a77[TrackPlacement] Type \u00a7ftrack help\u00a7r for operator commands.");
                }
            }
        }
    });
});
