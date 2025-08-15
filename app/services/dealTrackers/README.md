# Deal Trackers

Deal trackers receive notifications when a position closes and can persist the trade information or forward it elsewhere.

## Configuration

Trackers are configured in `app/config/deal-trackers.json`. Each entry specifies a `type` and tracker specific options. Values may reference environment variables using the `${ENV:VAR}` syntax.

### Duplicate protection (`skipExisting`)

Some trackers accept a `skipExisting` array. Each element has:

- `field` – key written to the destination (for the Obsidian tracker this is a front‑matter field).
- `prop` – property on the trade object sent to the tracker.

When all listed fields are present in the existing note with matching values, the tracker skips creating a new record. The Obsidian tracker also writes these fields into the note's front matter so future runs can detect duplicates.

Example configuration:

```json
{
  "trackers": [{
    "type": "obsidian",
    "vaultPath": "${ENV:OBSIDIAN_INDEPSTATE_VAULT}",
    "journalPath": "${ENV:OBSIDIAN_INDEPSTATE_DEALS_JOURNAL}",
    "skipExisting": [{ "field": "TV-LOG-KEY", "prop": "_key" }]
  }]
}
```

The TradingView log service emits `_key` for each closed trade; pairing it with `skipExisting` prevents overwriting existing notes.

## API

`dealTrackers.notifyPositionClosed(info)` dispatches the `info` object to all configured trackers. Each tracker implements `onPositionClosed(info)` to handle the data.
