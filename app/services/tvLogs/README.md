# TradingView Log Service

This service converts TradingView order CSV logs into closed trade events consumed by deal trackers.

## Configuration

Settings live in `app/config/tv-logs.json`:

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
    { "tactic": "example", "path": "${ENV:TV_LOG_EXAMPLE}" }
  ]
}
```

- `enabled` – set `false` to prevent automatic polling from `main.js`.
- `pollMs` – interval in milliseconds used to check files for changes.
- `accounts` – list of tactic accounts with a `tactic` name and paths to their CSV logs. Paths may reference environment variables using `${ENV:VAR}`.
- `skipExisting` – array mapping front‑matter fields to trade properties so trackers can detect existing notes.
- `sessions` – optional mapping of `"HH:MM-HH:MM"` ranges to session numbers used for the `tradeSession` field.

## Processing rules

For each account the service:

1. Reads the TradingView CSV file formatted as `Symbol,Side,Type,Qty,Limit Price,Stop Price,Fill Price,Status,Commission,Leverage,Margin,Placing Time,Closing Time,Order ID`.
2. Groups orders by symbol and placing time, keeping tuples where two orders are `Filled`.
3. Determines trade side and entry price from the earliest order.
4. Detects the minimal tick for each symbol by collecting all price strings and computing the greatest common divisor of their differences. Point distances such as `takeSetup` and `stopSetup` are then derived with this tick size and truncated to integer points.
5. Derives the result (`take` or `stop`), `takePoints`/`stopPoints` using the same tick metadata, sums commission, rounds profit to two decimals and calculates `tradeRisk` as:
   - `(profit ÷ takePoints) × stopSetup` when `takePoints` are present
   - `(profit ÷ stopPoints) × stopSetup` when `stopPoints` are present
6. Strips the exchange prefix from the symbol and the time portion from the placing time, then determines `tradeSession` using the configured `sessions` map.
7. Emits an object per closed trade to `dealTrackers.notifyPositionClosed` with fields such as `ticker`, `tp`, `sp`, `status`, `profit`, `commission`, `takePoints`, `stopPoints`, `side`, `tradeRisk`, `tradeSession`, `_key` and the account `tactic`, passing along the configured `skipExisting` rules to avoid duplicate notes.

The `_key` combines the raw symbol and placing time and is suitable for use in `skipExisting`.

## Usage

Call `processAll()` to parse files once or `start()` to poll continuously.
