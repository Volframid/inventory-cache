# Inventory Cache

TERA Toolbox module. Author: CEM.

Reduces repeated inventory and equipment updates sent to the game client. It sends no skill, movement or server packets.

Only byte-identical, unsolicited lists already delivered to the client are filtered. Changes to items, rolls, equipment, money or pocket count pass through. Opening inventory or requesting a list always passes through.

Multipart lists are tracked separately for each container and pocket, in their original order. If a later part changes, previously filtered parts are restored before the changed part, with no added acceptance timer. Other inventory modules still receive the server data.

## Installation

Download the repository ZIP, extract it and put the `inventory-cache` folder inside Toolbox's `mods` folder. Restart Toolbox. The module defaults to ON; on/off and measurement preferences are saved in `config.json`.

When replacing ItemCacheLight, keep only one copy enabled. Move your existing `config.json` into the new folder before removing the old copy. An existing installation can also stay in its original folder: the module name and update source identify it as Inventory Cache.

## Commands

| Command | Action |
| --- | --- |
| `cache` / `cache status` | Show mode, cache memory, packet counters and optional timing |
| `cache on` | Enable filtering and start fresh counters |
| `cache off` | Pass all inventory packets and start fresh counters |
| `cache reset` | Clear cached lists; restore any temporarily filtered prefix |
| `cache stats reset` | Start fresh counters; close any partial comparison safely |
| `cache measure on` / `cache measure off` | Enable/disable processing-time measurement; default OFF |
| `cache reload` | Reload validated settings; updating code requires a Toolbox restart |

`suppressed` counts packets filtered initially. `replayed` counts filtered parts later restored because something changed. `net saved` subtracts those restored bytes. Timing shows this hook's processing cost, including prefix restoration when needed, and excludes the dispatcher's initial buffer copy. It is not game FPS or frame time. There is no continuous disk logging.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Filter repeated lists |
| `measure` | `false` | Measure processing time |
| `maxCacheBytes` | `8388608` | Limit completed cached packet bytes to 8 MiB |
| `maxListBytes` | `2097152` | Limit a partial list to 2 MiB; cannot exceed cache limit |
| `maxEntries` | `128` | Bound completed lists and shared header contexts |
| `maxChunksPerList` | `128` | Bound a partial list's number of parts |
| `partialTimeoutMs` | `5000` | Restore a filtered prefix if a series stops arriving |

The byte limits describe stored packet payloads, not total process memory. Partial list data and object overhead are additional. Exceeding a limit disables caching for that series and passes the remaining packets; it does not truncate the data.

## Safety and compatibility

The raw layout is verified for `S_ITEMLIST` v4. A newer/unavailable definition disables filtering and keeps packets flowing. Unexpected or incomplete data passes through. This does not repair malformed server packets for other modules.

Login, lobby and map loading clear cached state. Turning the module off or unloading it restores any withheld prefix. External fake or blocked packets invalidate the relevant comparison; another module's packet changes or suppression are respected. Replay errors appear in `cache status`.

Configuration writes are atomic. Invalid startup settings are backed up before defaults are restored; a failed reload keeps the running settings.

## Comparing performance

1. Restart Toolbox. Use `cache on` and warm up in the same fight/loot area.
2. Use `cache stats reset`, repeat a representative fight, then check `cache status`.
3. Use `cache off` and repeat under similar conditions. Compare game FPS and, where available, the frame-time display; average FPS alone can miss brief stalls.
4. Return to `cache on`. Use `cache measure on` only when measuring the hook itself, then turn it off afterward.

Local tests use the real Toolbox packet processor and core inventory consumer. Synthetic timing comparisons are not proof of a particular live FPS increase. Live performance and item/UI behavior still need gameplay verification.

Automatic updates are enabled and fetched from the `main` branch of [Volframid/inventory-cache](https://github.com/Volframid/inventory-cache). User settings are protected by the update manifest. Future releases must refresh the manifest hashes alongside the changed files.
