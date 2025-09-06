# Configuration

This directory contains the application's default configuration files. To
customize any of them, copy the desired file to a `config` directory inside the
application's user data path (see Electron's `app.getPath('userData')`) and edit
it there. Files in this user data `config` folder override the defaults in this
directory; values are deep‑merged onto the bundled configuration. When running
from source, a `./config` folder in the project root is also checked for
overrides, but settings under the user data path take precedence.

Example:

Example (PowerShell):

```powershell
mkdir "$env:APPDATA/ISCC/config"
copy app/config/order-cards.json "$env:APPDATA/ISCC/config/order-cards.json"
```

Changes in `config/order-cards.json` (and other files) take effect on the next
application start. The `config` directory under user data is ignored by git so
personal settings aren't tracked.

## Loading configuration in code

Application modules should load configuration files via the helper in
`app/config/load.js`:

```js
const loadConfig = require('./config/load');
const orderCards = loadConfig('order-cards.json');
```

`loadConfig()` looks for an override in the user data `config` directory and
deep‑merges its contents onto the defaults bundled in this directory.

## Order Card Source Configuration

The `order-cards.json` file lists every source that can feed order cards into the
application. The file contains a single object with a `sources` array and optional
settings such as a default stop value in dollars for equity cards, how to treat
events for cards already in a final state or which action buttons to show on
each card:

```json
{
  "sources": [
    { "type": "webhook" },
    { "type": "file", "pathEnvVar": "ORDER_CARDS_PATH", "pollMs": 1000 }
  ],
  "defaultEquityStopUsd": 50,
  "closedCardEventStrategy": "ignore",
  "buttons": [
    { "label": "BL",  "action": "BL",  "style": "bl" },
    { "label": "BC",  "action": "BC",  "style": "bc" },
    { "label": "BFB", "action": "BFB", "style": "bc" },
    { "label": "SL",  "action": "SL",  "style": "sl" },
    { "label": "SC",  "action": "SC",  "style": "sc" },
    { "label": "SFB", "action": "SFB", "style": "sc" }
  ]
}
```

Each entry in `sources` is an object with a `type` field and additional options
depending on the type. Multiple sources can be defined and their orders are
merged together.

If `defaultEquityStopUsd` is present, its numeric value (in dollars) is used as a
pre-filled Risk $ field for new equity order cards. The
`DEFAULT_EQUITY_STOP_USD` environment variable (if set) overrides this value.

`closedCardEventStrategy` determines how the app handles a new order event for a
ticker whose card is already closed (`take`/`stop`). When set to `"ignore"`
(default) such events are discarded. Setting it to `"revive"` reactivates the
card with the fresh data, making it ready for a new order.

`buttons` lets you customize the set of buttons rendered on each order card.
Each entry specifies the button text (`label`), the action (`action`) sent when
it is clicked and an optional `style` class applied to the button. When `style`
is omitted, the lowercase action is used. If `buttons` is omitted entirely, the
default buttons are `BL`, `BC`, `BFB`, `SL`, `SC` and `SFB`.


## Pending Order Strategies

`pending-strategies.json` defines default options for pending‑order execution
strategies. Each top‑level key corresponds to a strategy name and its value
contains options that are merged with per‑order parameters. Some options, such
as `rangeRule`, `limitPriceFn` and `stopLossFn`, may be specified as the name of
a built‑in helper function:

```json
{
  "consolidation": {
    "bars": 3,
    "rangeRule": "B1_RANGE_CONSOLIDATION",
    "limitPriceFn": "defaultLimitPrice",
    "stopLossFn": "defaultStopLoss"
  },
  "falseBreak": { "tickSize": 0.01 }
}
```

Override this file in `config/pending-strategies.json` to customize the defaults.

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

`trade-rules.json` enables and configures validation rules that guard order
placement. The file contains a `rules` object; each key corresponds to a rule
name and its value holds that rule's options. Clients invoke the aggregated
`TradeRules` service without needing to know which concrete rules are enabled.

### `maxOrderPriceDeviation`
Limits how far an order's price may deviate from the latest quote:

```json
{
  "rules": {
    "maxOrderPriceDeviation": {
      "maxPriceDeviationPct": 0.5
    }
  }
}
```

### `minStopPoints`
Ensures a stop-loss is not set too close to the entry price. The rule can be
configured with a global default, per‑instrument overrides and even a custom
function evaluated for each order:

```json
{
  "rules": {
    "minStopPoints": {
      "default": 6,
      "byInstrumentType": { "FX": 4 },
      "fn": "if(card.sl < 10) return {ok:false, reason:'SL \u2265 10'}; return {ok:true};"
    }
  }
}
```

If `fn` is supplied it receives the order `card` and current `quote` and should
return either a boolean or an object with an `ok` flag and optional `reason`.

### `maxQty`
Restricts the maximum quantity allowed per order. A global default can be
overridden for specific instrument types:

```json
{
  "rules": {
    "maxQty": {
      "default": 1000,
      "byInstrumentType": { "CX": 10, "FX": 100, "EQ": 1000 }
    }
  }
}
```

Additional rules can be added over time and wired up in `trade-rules.json`
without requiring changes to callers.

