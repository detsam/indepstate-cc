# Deal Trackers

Deal trackers receive notifications when a position closes and can persist the trade information or forward it elsewhere.

## Configuration

Trackers are configured in `app/config/deal-trackers.json`. Each entry specifies a `type` and tracker specific options. Values may reference environment variables using the `${ENV:VAR}` syntax.

An Obsidian tracker can optionally include a `chartImageComposer` block. When
present the tracker queues a screenshot request for the trade symbol and
inserts the image file name into the note under the `\t- 1D` line. The composer
runs only after duplicate checks confirm a new note will be created. Screenshot
downloads occur in the background, so the linked file may appear shortly after
the note is written.

## API

`dealTrackers.notifyPositionClosed(info, opts)` dispatches the `info` object to all configured trackers. Each tracker implements `onPositionClosed(info, opts)` to handle the data.

### Duplicate protection

Pass a `skipExisting` array in the `opts` object to request duplicate checks. Each element has:

- `field` – key written to the destination (for the Obsidian tracker this is a front‑matter field).
- `prop` – property path on the trade object sent to the tracker (dot notation supported).

When all listed fields are found with matching values the tracker skips creating a new record. The Obsidian tracker also writes these fields into the note's front matter so future runs can detect duplicates.

### Obsidian tracker fields

The Obsidian deal tracker expects an `info` object with properties describing the trade. When present the tracker substitutes matching lines in the `Template. Deal.md` note:

- `symbol` – object `{ exchange?, ticker }`; `ticker` is injected into `- Ticker:: [[Ticker. TICKER]]`
- `tactic` – fills the `- Tactics::` line
- `side` – sets `- Direction:: [[Direction. Long]]` or `[[Direction. Short]]`
- `status` – selects `- Status:: [[Result. Take]]` or `[[Result. Stop]]`
- `profit` – written to `- Trade Profit::`
- `commission` – overrides `- Trade Commissions::` when non-zero
- `tp` / `sp` – replace `- Take Setup::` and `- Stop Setup::`
- `takePoints` / `stopPoints` – fill `- Take Points::` and `- Stop Points::` when provided
- `tradeRisk` – replaces `- Trade Risk::` when defined
- when `status` is `take`, the tracker sets `- Homework:: [[Analysis. Right Direction]]`
- `tradeSession` – fills the `- Trade Session::` line when supplied
- when configured with a chart image composer, the tracker writes
  `\t- 1D ![[filename]]` linking to the generated screenshot
