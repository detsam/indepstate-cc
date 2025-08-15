# Deal Trackers

Deal trackers receive notifications when a position closes and can persist the trade information or forward it elsewhere.

## Configuration

Trackers are configured in `app/config/deal-trackers.json`. Each entry specifies a `type` and tracker specific options. Values may reference environment variables using the `${ENV:VAR}` syntax.

## API

`dealTrackers.notifyPositionClosed(info, opts)` dispatches the `info` object to all configured trackers. Each tracker implements `onPositionClosed(info, opts)` to handle the data.

### Duplicate protection

Pass a `skipExisting` array in the `opts` object to request duplicate checks. Each element has:

- `field` – key written to the destination (for the Obsidian tracker this is a front‑matter field).
- `prop` – property on the trade object sent to the tracker.

When all listed fields are found with matching values the tracker skips creating a new record. The Obsidian tracker also writes these fields into the note's front matter so future runs can detect duplicates.
