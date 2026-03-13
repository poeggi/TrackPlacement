import { world, system } from "@minecraft/server";

// --------------------------------------------------------------------------
// TrackPlacement - Bedrock Dedicated Server behavior pack
// UUID: 560fee0a-73c1-4f03-9c27-3ae8ba58344a
//
// Operator commands require Beta APIs to be enabled on the world.
// When enabled, commands are typed in chat (t or /) by operators:
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
// Without Beta APIs, tracking and alerts still work fully.
// Only the operator chat commands are unavailable.
//
// Alert tags:
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
const CLUSTER_RADIUS       = 8;
const DISPENSER_ACTOR      = "_dispenser";
const SESSION_MAX_TICKS    = 12000; // 10 minutes
const SESSION_SNAP_TICKS   = 20;   // snapshot interval - 1 second
const SESSION_CLOSE_DIST   = 6;    // blocks - player walked away

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

// eventLog entries: {type, actor, id, label, coords, dimId, wasIgnored}
const eventLog       = [];
// ignoredPlayers map: player name -> {by, time}
const ignoredPlayers = new Map();
const windows        = {};

// containerSessions: playerName -> {
//   blockTypeId, blockPos, dimId,
//   intervalId, timeoutId
// }
const containerSessions = new Map();

// --------------------------------------------------------------------------
// Config
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
// Utilities
// --------------------------------------------------------------------------

function stripNamespace(id) {
    return id.replace("minecraft:", "");
}

function formatCoords(loc) {
    return "(" + Math.floor(loc.x) + ", " + Math.floor(loc.y) + ", " + Math.floor(loc.z) + ")";
}

function parseCoords(str) {
    const m = str.match(/\((-?\d+), (-?\d+), (-?\d+)\)/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
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

function clusterCoords(coordList) {
    const clusters = [];
    for (const coord of coordList) {
        const pt    = parseCoords(coord);
        const match = pt && clusters.find(c => dist3d(c.anchorPt, pt) <= CLUSTER_RADIUS);
        if (match) {
            match.count++;
        } else {
            clusters.push({ anchor: coord, anchorPt: pt, count: 1 });
        }
    }
    return clusters;
}

function formatClusters(clusters, coordColor, plain) {
    return clusters.map(c => {
        const prefix = c.count > 1 ? "near " : "";
        const loc    = plain
            ? prefix + c.anchor
            : prefix + coordColor + c.anchor + "\u00a7r";
        return c.count > 1 ? loc + " (x" + c.count + ")" : loc;
    }).join(", ");
}

function countPreviousEvents(actor, type, itemId) {
    return eventLog.filter(e => e.actor === actor && e.type === type && e.id === itemId).length + 1;
}

// --------------------------------------------------------------------------
// Rate-limit windows
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
// Output
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

// Always record to eventLog. Ignored players are logged with wasIgnored=true
// but do not trigger console output or chat alerts.
// Always record to eventLog. Ignored players are logged with wasIgnored=true
// but do not trigger console output or chat alerts.
function fireAlert(type, actor, label, itemId, coords, dimId, color, windowTicks) {
    const isIgnored = ignoredPlayers.has(actor);
    const total     = countPreviousEvents(actor, type, itemId);
    eventLog.push({ type, actor, id: itemId, label, coords, dimId, wasIgnored: isIgnored });
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
//   4. Hard cap at SESSION_MAX_TICKS (10 minutes).
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
    endContainerSession(player.name);
    const blockPos    = { x: block.location.x, y: block.location.y, z: block.location.z };
    const blockTypeId = block.typeId;
    const dimId       = dimension.id;
    const alertTag    = CONTAINER_TAGS[blockTypeId] ?? "CONT_LOAD";
    const coordStr    = formatCoords(blockPos);
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
                fireAlert(alertTag, player.name, meta.label, typeId, coordStr, dimId, meta.alert_color, meta.window_ticks);
            }
        }
    }, SESSION_SNAP_TICKS);
    const timeoutId = system.runTimeout(() => {
        endContainerSession(player.name);
    }, SESSION_MAX_TICKS);
    containerSessions.set(player.name, { blockTypeId, blockPos, dimId, intervalId, timeoutId });
}

// --------------------------------------------------------------------------
// Operator commands
// Requires Beta APIs. Registered only if detected at startup.
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
        sender.sendMessage("  \u00a77#" + (i + 1) + " \u00a7e" + actor + "\u00a7r | \u00a7f" + e.label + "\u00a7r | \u00a7b" + e.coords + "\u00a7r | " + dimColored(e.dimId) + " | \u00a77" + e.type + "\u00a7r" + ignoredTag);
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
    if (sub === "help") {
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
// Attempt to register chat commands using beforeEvents.chatSend (Beta APIs only).
// If the API is unavailable, logs a notice and leaves commands inactive.
function tryRegisterChatCommands() {
    try {
        if (!world.beforeEvents || typeof world.beforeEvents.chatSend?.subscribe !== "function") {
            throw new Error("chatSend not available");
        }
        world.beforeEvents.chatSend.subscribe((event) => {
            if (!event.message.startsWith("track ")) return;
            event.cancel = true;
            const sender  = event.sender;
            const message = event.message;
            system.run(() => handleCommand(sender, message));
        });
        chatCommandsActive = true;
        console.log("[TrackPlacement] Beta APIs detected - chat commands active. Type 'track help' in chat.");
    } catch (e) {
        chatCommandsActive = false;
        console.log("[TrackPlacement] Beta APIs not enabled - chat commands inactive. Enable Beta APIs on this world to use operator commands.");
    }
}

// --------------------------------------------------------------------------
// Event listeners
// --------------------------------------------------------------------------

function registerListeners() {
    // Block placements
    world.afterEvents.playerPlaceBlock.subscribe((event) => {
        const { block, player, dimension } = event;
        if (!blockMap.has(block.typeId)) return;
        const meta = blockMap.get(block.typeId);
        if (!inAllowedDimension(meta, dimension.id)) return;
        fireAlert("PLACE", player.name, meta.label, block.typeId, formatCoords(block.location), dimension.id, meta.alert_color, meta.window_ticks);
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
        const { target, player, itemStack } = event;
        const dimension = event.dimension ?? player?.dimension;
        if (!itemStack || !target || !dimension || !entitySet.has(target.typeId) || !itemMap.has(itemStack.typeId)) return;
        const meta = itemMap.get(itemStack.typeId);
        if (!inAllowedDimension(meta, dimension.id)) return;
        fireAlert("ENTITY", player.name, meta.label, itemStack.typeId, formatCoords(target.location), dimension.id, meta.alert_color, meta.window_ticks);
    });
    // Craft / pickup
    world.afterEvents.playerInventoryItemChange.subscribe((event) => {
        const { player, itemStack, changeType } = event;
        if (changeType !== "added" || !itemStack || !itemMap.has(itemStack.typeId)) return;
        const meta = itemMap.get(itemStack.typeId);
        if (!inAllowedDimension(meta, player.dimension.id)) return;
        fireAlert("PICKUP", player.name, meta.label, itemStack.typeId, formatCoords(player.location), player.dimension.id, meta.alert_color, meta.window_ticks);
    });
    // Dispenser / dropper fires tracked entity
    world.afterEvents.entitySpawn.subscribe((event) => {
        const entity = event.entity;
        if (!entity || !entity.typeId || !dispenserEntities.has(entity.typeId)) return;
        const spawnX = Math.floor(entity.location.x);
        const spawnY = Math.floor(entity.location.y);
        const spawnZ = Math.floor(entity.location.z);
        const dim    = entity.dimension;
        const dimId  = dim.id;
        const offsets = [{x:1,y:0,z:0},{x:-1,y:0,z:0},{x:0,y:0,z:1},{x:0,y:0,z:-1},{x:0,y:1,z:0},{x:0,y:-1,z:0}];
        const fromDispenser = offsets.some(o => {
            try {
                const b = dim.getBlock({ x: spawnX + o.x, y: spawnY + o.y, z: spawnZ + o.z });
                return b && (b.typeId === "minecraft:dispenser" || b.typeId === "minecraft:dropper");
            } catch { return false; }
        });
        if (!fromDispenser) return;
        const coordStr = "(" + spawnX + ", " + spawnY + ", " + spawnZ + ")";
        const meta     = itemMap.has(entity.typeId)
            ? itemMap.get(entity.typeId)
            : { label: stripNamespace(entity.typeId), alert_color: "\u00a76", window_ticks: DEFAULT_WINDOW_TICKS, dimensions: null };
        fireDispenserAlert(meta.label, entity.typeId, coordStr, dimId, meta.alert_color, meta.window_ticks);
    });
    // Clean up container sessions on player disconnect
    world.afterEvents.playerLeave.subscribe((event) => {
        endContainerSession(event.playerName);
    });
    tryRegisterChatCommands();
}

// --------------------------------------------------------------------------
// Startup
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
