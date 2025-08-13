# Order Card Source Configuration

The `order-cards.json` file lists every source that can feed order cards into the
application. The file contains a single object with a `sources` array:

```json
{
  "sources": [
    { "type": "webhook" },
    { "type": "file", "pathEnvVar": "ORDER_CARDS_PATH", "pollMs": 1000 }
  ]
}
```

Each entry in `sources` is an object with a `type` field and additional options
depending on the type. Multiple sources can be defined and their orders are
merged together.

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


