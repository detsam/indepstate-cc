# Deal Trackers: TradingView Log Source

This service converts TradingView order CSV logs into closed trade events consumed by deal trackers.

## Configuration

Settings live in `app/services/dealTrackers-source-tv-log/config/tv-logs.json`:

```json
{
  "enabled": true,
  "pollMs": 5000,
  "skipExisting": [
    { "field": "TV-LOG-KEY", "prop": "_key" }
  ],
  "sessions": {
    "02:00-06:00": 1,
    "06:00-16:30": 2,
    "16:30-02:00": 3
  },
  "accounts": [
    {
      "tactic": "example",
      "dir": "${ENV:TV_LOG_EXAMPLE}",
      "maxAgeDays": 2,
      "symbolReplace": "return s.replace(/(.*)PERP$/, 'BINANCE:$1.P');",
      "fees": { "maker": 0.02, "taker": 0.05 }
    }
  ]
}
```

- `enabled` – set `false` to prevent automatic polling from `main.js`.
- `pollMs` – interval in milliseconds used to check directories for new files.
- `accounts` – list of tactic accounts with a `tactic` name and directories containing their CSV logs. Paths may reference environment variables using `${ENV:VAR}`.
- `accounts[n].symbolReplace` – optional JavaScript function body run with each raw symbol string. By default it converts `FOOUSDTPERP` into `BINANCE:FOOUSDT.P` so image composers can resolve tickers.
- `accounts[n].fees` – optional maker/taker commission percentages used when a log has no commission column. Defaults to `0.02%` maker and `0.05%` taker.
- `accounts[n].maxAgeDays` – only emit deals with a placing date within this many days for the given account. Set to `0` to allow all deals (default `2`).
- `skipExisting` – array mapping front‑matter fields to trade properties so trackers can detect existing notes.
- `sessions` – optional mapping of `"HH:MM-HH:MM"` ranges to session numbers used for the `tradeSession` field.

On startup the service processes the most recently created file in each directory; any newly created files are processed as they appear.

## Processing rules

For each account the service:

1. Reads the TradingView CSV file formatted as `Symbol,Side,Type,Qty,Limit Price,Stop Price,Fill Price,Status,Commission,Leverage,Margin,Placing Time,Closing Time,Order ID` (or the newer format without the commission column).
2. Groups orders by symbol and placing time, keeping tuples where two orders are `Filled`.
3. Determines trade side and entry price from the earliest order.
4. Detects the minimal tick for each symbol by collecting all price strings and computing the greatest common divisor of their differences. Point distances such as `takeSetup` and `stopSetup` are then derived with this tick size and truncated to integer points.
5. Derives the result (`take` or `stop`), `takePoints`/`stopPoints` using the same tick metadata, sums commission (estimating from `fees` when the CSV omits it), rounds profit to two decimals and calculates `tradeRisk` as:
   - `(profit ÷ takePoints) × stopSetup` when `takePoints` are present
   - `(profit ÷ stopPoints) × stopSetup` when `stopPoints` are present
6. Splits the symbol into `exchange` and `ticker` parts and the placing time into date and time, then determines `tradeSession` using the configured `sessions` map.
7. Emits an object per closed trade to `dealTrackers.notifyPositionClosed` with fields such as `symbol`, `placingDate`, `tp`, `sp`, `status`, `profit`, `commission`, `takePoints`, `stopPoints`, `side`, `tradeRisk`, `tradeSession`, `_key` and the account `tactic`, passing along the configured `skipExisting` rules to avoid duplicate notes.

The `_key` combines the raw symbol and placing time and is suitable for use in `skipExisting`.

## Usage

Use `processFile(path)` to parse a single log file once or `start()` to poll directories for new files.
