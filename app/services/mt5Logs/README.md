# MT5 Log Service

This service converts MetaTrader 5 HTML trade history reports into closed trade events consumed by deal trackers.

## Configuration

Settings live in `app/config/mt5-logs.json`:

```json
{
  "enabled": true,
  "pollMs": 5000,
  "skipExisting": [
    { "field": "MT5-LOG-KEY", "prop": "_key" }
  ],
  "sessions": {
    "02:00-06:00": 1,
    "06:00-16:30": 2,
    "16:30-02:00": 3
  },
  "accounts": [
    { "tactic": "example", "dir": "${ENV:MT5_LOG_EXAMPLE}", "maxAgeDays": 2, "dwxProvider": "dwx" }
  ]
}
```

- `enabled` – set `false` to prevent automatic polling from `main.js`.
- `pollMs` – interval in milliseconds used to check directories for new files.
- `accounts` – list of tactic accounts with a `tactic` name and directories containing HTML reports. Paths may reference environment variables using `${ENV:VAR}`.
- `accounts[n].maxAgeDays` – only emit deals with a placing date within this many days for the given account. Set to `0` to allow all deals (default `2`).
- `skipExisting` – array mapping front‑matter fields to trade properties so trackers can detect existing notes.
- `sessions` – optional mapping of `"HH:MM-HH:MM"` ranges to session numbers used for the `tradeSession` field.
- `accounts[n].dwxProvider` – optional name of an execution provider whose DWX adapter supplies historic bars for that account. When omitted the service can init its own `dwx_client` if `dwx[provider].metatraderDirPath` is configured.
- `dwx[provider].metatraderDirPath` – optional path to the MetaTrader `MQLx/Files` directory for the given provider. When provided the service uses `dwx_client` to retrieve 5‑minute bars for computing `moveActualEP`.

On startup the service processes the most recently created file in each directory; any newly created files are processed as they appear.

## Processing rules

For each account the service:

1. Reads the MetaTrader 5 trade history HTML file and extracts rows from the **Positions** table.
2. Derives trade side, entry price and exit price from each row.
3. Calculates price differences such as `takeSetup` and `stopSetup` from the row's price fields, rounds them to two decimals and multiplies by `100` to get point distances.
4. Uses these values to determine the result (`take` or `stop`), derives `takePoints`/`stopPoints` the same way, adjusts commission so that any fee under `3` is replaced with either `3` (when volume < `500`) or `volume * 0.006 * 2` (when volume ≥ `500`), always stores commission as a positive amount, rounds profit to two decimals and calculates `tradeRisk`.
5. Splits the placing time into date and time (date normalized to `YYYY-MM-DD`), then determines `tradeSession` using the configured `sessions` map.
6. Optionally queries a `dwx_client` for 5‑minute bars of the trade's symbol for the trading day. From the entry time forward it searches for the furthest favourable price movement that does not hit the stop price, calculating `moveActualEP` – the distance in points from entry to that extreme.
7. Emits an object per closed trade to `dealTrackers.notifyPositionClosed` with fields such as `symbol`, `placingDate`, `tp`, `sp`, `status`, `profit`, `commission`, `takePoints`, `stopPoints`, `side`, `tradeRisk`, `tradeSession`, `moveActualEP`, `_key` and the account `tactic`, passing along the configured `skipExisting` rules to avoid duplicate notes.

The `_key` combines the raw symbol and placing time and is suitable for use in `skipExisting`.

## Usage

Use `processFile(path)` to parse a single log file once or `start()` to poll directories for new files.
