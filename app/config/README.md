# Configuration

This directory contains the application's default configuration files. To
customize any of them, copy the desired file to a `config/` directory in the
project root and edit it there. Files in `./config` override the defaults in
this folder; values are deep‑merged onto the bundled configuration.

Example:

```bash
mkdir -p config
cp app/config/order-cards.json config/order-cards.json
```

Changes in `config/order-cards.json` (and other files) take effect on the next
application start. The `config/` directory is ignored by git so personal
settings aren't tracked.

## Loading configuration in code

Application modules should load configuration files via the helper in
`app/config/load.js`:

```js
const loadConfig = require('./config/load');
const orderCards = loadConfig('order-cards.json');
```

`loadConfig()` looks for an override in `./config` and deep‑merges its
contents onto the defaults bundled in this directory.

## Order Card Source Configuration

The `order-cards.json` file lists every source that can feed order cards into the
application. The file contains a single object with a `sources` array and optional
settings such as a default stop value in dollars for equity cards:

```json
{
  "sources": [
    { "type": "webhook" },
    { "type": "file", "pathEnvVar": "ORDER_CARDS_PATH", "pollMs": 1000 }
  ],
  "defaultEquityStopUsd": 50
}
```

Each entry in `sources` is an object with a `type` field and additional options
depending on the type. Multiple sources can be defined and their orders are
merged together.

If `defaultEquityStopUsd` is present, its numeric value (in dollars) is used as a
pre-filled Risk $ field for new equity order cards. The
`DEFAULT_EQUITY_STOP_USD` environment variable (if set) overrides this value.

## Source types

### `webhook`
Accepts order cards pushed via HTTP webhook. No extra options are required.

### `file`
Watches a plain text file for order descriptions. Options:

- `pathEnvVar` – name of the environment variable that holds the path to the
  file. Defaults to `ORDER_CARDS_PATH`.
- `pollMs` – interval in milliseconds between file polls. Defaults to `1000`.

Each non-empty line in the file must be formatted as:

```
{TICKER} {PRICE} {SL POINTS} {TP POINTS} {QTY}
```

`TICKER` and `PRICE` are required. `SL` and `TP` points are optional, but `TP`
may only be specified when `SL` is also given. `QTY` is optional and may only be
specified when both `SL` and `TP` are present.

Example:

```
AAPL 185.5 50 100 1.5
MSFT 325
```


## Trade Rules

The `trade-rules.json` file defines limits for order placement.  The default
configuration sets `maxPriceDeviationPct` which caps how far an order's price
may deviate from the latest quote:

```json
{
  "maxPriceDeviationPct": 0.5
}
```


