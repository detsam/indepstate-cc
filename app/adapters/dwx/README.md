# DWX Adapter & Client (MT4/MT5 via DWX Connect)

Modules:

- **`dwx_client.js`** — Node.js port of the Python `dwx_client.py`. File-based IPC with MT4/MT5 EA/Script. Original **file names** and **command format** are preserved.
- **`adapters/dwx.js`** — Adapter for `ExecutionAdapter.placeOrder()`. Adds **pending/confirmation** semantics and **retry** support for `OPEN_ORDER`.

### Position lifecycle

`DWXAdapter` tracks the state of orders and positions and exposes:

- `listOpenOrders()` – snapshot of current MT orders
- `listClosedPositions()` – historic trades keyed by ticket

It emits events when positions change:

- `position:opened` `{ticket, order}`
- `position:closed` `{ticket, trade}`
- `order:cancelled` `{ticket}`

---

## Table of Contents

1. [Purpose](#purpose)  
2. [Architecture](#architecture)  
3. [DWX File Protocol](#dwx-file-protocol)  
4. [`dwx_client.js` API](#dwx_clientjs-api)  
5. [`DWXAdapter` behavior](#dwxadapter-behavior)  
6. [Main/Renderer wiring](#mainrenderer-wiring)  
7. [Retries (`open_order`)](#retries-open_order)  
8. [Examples (logs & files)](#examples-logs--files)  
9. [Troubleshooting](#troubleshooting)  
10. [FAQ](#faq)  
11. [License & Compatibility](#license--compatibility)

---

## Purpose

Provide an integration layer that enables an application to work with **MetaTrader 4/5** terminals via **DWX Connect** using a file-based protocol. Orders may originate from **abstract order sources** (e.g., UI, TradingView, strategy engines, scripts, queues). The client handles file-level communication; the adapter adds reliable **pending/confirmation** handling and **retries** so that application state reflects the actual terminal state.

---

## Architecture

```mermaid
flowchart LR
  SRC[Abstract Order Source(s)<br/>(UI, TV, algo, CLI, queue)] --> MAIN[Ingestion/Orchestrator<br/>(Electron main)]
  MAIN -- placeOrder() --> ADP[DWXAdapter]
  ADP -- commands --> FILES[.../MQLx/Files/DWX]
  FILES --- MT5[MT4/MT5 EA]
  MT5 -- writes updates --> FILES
  ADP -- reads --> FILES
  ADP -- order:confirmed / rejected / timeout --> MAIN
  MAIN -- IPC: execution:pending --> UI[Renderer (cards)]
  MAIN -- IPC: execution:result --> UI
```

### Sequence: placement with confirmation

```mermaid
sequenceDiagram
  participant SRC as Abstract Source (UI/TV/Algo)
  participant MAIN as Orchestrator (main)
  participant ADP as DWXAdapter
  participant CLIENT as dwx_client.js
  participant EA as MT4/MT5 (DWX EA)

  SRC->>MAIN: submit order (normalized intent)
  MAIN->>ADP: placeOrder(normalized)
  ADP->>ADP: generate cid; append to comment
  ADP->>CLIENT: open_order(symbol,type,lots,price,sl,tp,magic,comment,expiration)
  CLIENT->>FILES: write DWX_Commands_N.txt
  EA->>EA: read command; execute
  ADP-->>MAIN: {status: ok, providerOrderId: "pending:<cid>"}
  MAIN-->>SRC: execution:pending {reqId, pendingId=cid}

  alt Confirm via messages
    EA->>FILES: DWX_Messages.txt {millis:{ticket, ok, comment:"...cid:xxxx"}}
    CLIENT->>ADP: on_message
    ADP->>ADP: match cid → confirm
    ADP-->>MAIN: order:confirmed {cid, ticket}
    MAIN-->>SRC: execution:result {status: ok, providerOrderId: ticket}
  else Confirm via orders file
    EA->>FILES: DWX_Orders.txt orders[ticket].comment has cid
    CLIENT->>ADP: on_order_event
    ADP->>ADP: match cid in comment → confirm
    ADP-->>MAIN: order:confirmed {cid, ticket}
    MAIN-->>SRC: execution:result {status: ok, providerOrderId: ticket}
  end

  opt Failure
    EA->>FILES: DWX_Messages.txt {type:"ERROR", reason, comment:"...cid"}
    CLIENT->>ADP: on_message
    ADP-->>MAIN: order:rejected {cid, reason}
    MAIN-->>SRC: execution:result {status: rejected, reason}
  end

  opt Timeout
    ADP->>ADP: confirmTimeoutMs elapsed
    ADP-->>MAIN: order:timeout {cid}
    MAIN-->>SRC: execution:result {status: rejected, reason: "timeout"}
  end
```

---

## DWX File Protocol

Location: `.../MQL4(or MQL5)/Files/DWX`

- **Commands:** `DWX_Commands_0.txt` … `DWX_Commands_49.txt`  
  Format: `<:command_id|COMMAND|payload:>` written to the first free file.
- **Messages:** `DWX_Messages.txt` — JSON map `{ "<millis>": <message>, ... }` (processed in ascending key order).
- **Orders & account:** `DWX_Orders.txt` — JSON `{ "account_info": {...}, "orders": {...} }`.
- **Market/Bar:** `DWX_Market_Data.txt`, `DWX_Bar_Data.txt`.
- **Historic:** `DWX_Historic_Data.txt`, `DWX_Historic_Trades.txt`.
- **Stored state for restart:** `DWX_Orders_Stored.txt`, `DWX_Messages_Stored.txt`.

Default polling delay: **5 ms** (`sleep_delay = 0.005`).

---

## `dwx_client.js` API

Node.js port of the Python client with identical file names and behavior.  
Minimum runtime: Node 16+.

### Construction

```js
const { dwx_client } = require('./dwx_client');

const client = new dwx_client({
  metatrader_dir_path: 'C:/.../MQL5/Files',
  sleep_delay: 0.005,               // seconds
  max_retry_command_seconds: 10,    // attempts to find a free command file
  load_orders_from_file: true,
  verbose: true,
  event_handler: {
    on_order_event(){},
    on_message(m){},
    on_tick(symbol,bid,ask){},
    on_bar_data(symbol,tf,t,o,h,l,c,vol){},
    on_historic_data(symbol,tf,data){},
    on_historic_trades(){}
  }
});
client.start(); // required when event_handler is provided
```

### Subscriptions & data

```js
client.subscribe_symbols(['EURUSD', 'GBPUSD']);
client.subscribe_symbols_bar_data([['EURUSD','M1'], ['GBPUSD','H1']]);
client.get_historic_data({ symbol:'EURUSD', time_frame:'D1', start: 1700000000, end: 1700600000 });
client.get_historic_trades(30);
```

### Orders

```js
client.open_order('EURUSD', 'buylimit', 0.2, 1.0835, 1.0815, 1.0875, 42, 'TV-signal | cid:abcd', 0);
client.modify_order(123456, 1.0835, 1.0810, 1.0880, 0);
client.close_order(123456, 0);
client.close_all_orders();
client.close_orders_by_symbol('EURUSD');
client.close_orders_by_magic(42);
client.reset_command_ids();
```

The client writes commands with a mutex; if all command files are in use, writing is retried for up to `max_retry_command_seconds`.

---

## `DWXAdapter` behavior

Implements `ExecutionAdapter.placeOrder()` with pending/confirmation logic.

### Normalized input

```ts
{
  symbol: string,
  side: 'buy'|'sell',
  type: 'market'|'limit'|'stop',
  price?: number,         // required for limit/stop
  sl?: number, tp?: number,
  qty: number,
  magic?: number, comment?: string, expiration?: number,
  meta?: { openOrderRetries?: number } // per-order retries override
}
```

Mapping to DWX order types:
- `market` → `buy` / `sell`
- `limit`  → `buylimit` / `selllimit`
- `stop`   → `buystop` / `sellstop`

### Pending & confirmation

- A CID is generated and appended to the comment: `cid:<hex>`.
- `placeOrder()` returns `{ status:'ok', providerOrderId:'pending:<cid>' }`.
- The adapter reconciles pending state using:
  - `DWX_Messages.txt` (INFO/OK/ERROR with comment containing the CID);
  - `DWX_Orders.txt` (new ticket where `comment` contains the CID).
- Events emitted by the adapter:
  - `order:confirmed` → `{ pendingId, ticket, mtOrder, origOrder }`
  - `order:rejected`  → `{ pendingId, reason, msg, origOrder }`
  - `order:timeout`   → `{ pendingId, origOrder }`

Configuration options (constructor):
- `provider` (default `dwx-mt5`)
- `metatrader_dir_path` (required)
- `verbose` (default `false`)
- `confirmTimeoutMs` (default `7000`)
- `openOrderRetries` (default `0`)
- `openOrderRetryDelayMs` (default `25`)
- `openOrderRetryBackoff` (default `2`)
- `event_handler` (optional; proxied into `dwx_client`)

---

## Main/Renderer wiring

**Main process:**
- When `placeOrder()` returns a result with `providerOrderId` starting with `pending:`, send `execution:pending` and store mapping `pendingId → reqId`.
- Subscribe to `order:confirmed` / `order:rejected` / `order:timeout` from the adapter and forward a final `execution:result`.

**Renderer process:**
- On `execution:pending`: set card to pending (`.card--pending`), disable action buttons.
- On `execution:result`: remove card only when `status:'ok'`. For `rejected`/`timeout`, unpend, highlight error, and keep the card.

---

## Retries (`open_order`)

An additional retry layer is implemented in the adapter (on top of the client’s mutex/command-file retry):

- **Adapter options**
  - `openOrderRetries`: number of additional attempts (0 = no retries).
  - `openOrderRetryDelayMs`: initial delay before retry (ms).
  - `openOrderRetryBackoff`: exponential backoff multiplier.

- **Per-order override**
  ```js
  await exec.placeOrder({
    symbol: 'EURUSD', side: 'buy', type: 'limit', price: 1.0835,
    sl: 1.0815, tp: 1.0875, qty: 0.2,
    meta: { openOrderRetries: 3 }
  });
  ```

On final failure, a rejection is emitted and a rejected result is returned; pending is cleared accordingly.

---

## Examples (logs & files)

### `logs/executions.jsonl`

Queued (pending created):
```json
{"t": 1722850000000, "kind": "place-queued", "reqId":"1722850_abcd12","adapter":"dwx-mt5","pendingId":"e3b1c2d4e5","order":{"symbol":"EURUSD","side":"buy","type":"limit","price":1.0835,"sl":1.0815,"tp":1.0875,"qty":0.2}}
```

Confirmed:
```json
{"t": 1722850000123, "kind": "confirm", "reqId":"1722850_abcd12","provider":"dwx-mt5","status":"ok","providerOrderId":"12345678","pendingId":"e3b1c2d4e5","order":{"symbol":"EURUSD","side":"buy","type":"limit","price":1.0835,"sl":1.0815,"tp":1.0875,"qty":0.2},"mtOrder":{"ticket":12345678,"symbol":"EURUSD","type":"buylimit","lots":0.2,"open_price":1.0835,"comment":"TV-signal | cid:e3b1c2d4e5"}}
```

Rejected:
```json
{"t": 1722850000456, "kind": "reject", "reqId":"1722850_abcd12","provider":"dwx-mt5","status":"rejected","reason":"Invalid stops","pendingId":"e3b1c2d4e5","order":{"symbol":"EURUSD","side":"buy","type":"limit","price":1.0835,"sl":1.0800,"tp":1.0875,"qty":0.2}}
```

Timeout:
```json
{"t": 1722850007000, "kind": "timeout", "reqId":"1722850_abcd12","provider":"dwx-mt5","status":"rejected","reason":"timeout","pendingId":"e3b1c2d4e5","order":{"symbol":"EURUSD","side":"buy","type":"limit","price":1.0835,"sl":1.0815,"tp":1.0875,"qty":0.2}}
```

### `DWX_Messages.txt` (example)

```json
{
  "1722850000100": {"type":"INFO","text":"Order opened","ticket":12345678,"comment":"TV-signal | cid:e3b1c2d4e5"},
  "1722850000200": {"type":"ERROR","reason":"Invalid stops","comment":"TV-signal | cid:deadbeef"}
}
```

### `DWX_Orders.txt` (example)

```json
{
  "account_info": {"equity":10000,"balance":10000,"margin":0},
  "orders": {
    "12345678": {
      "ticket": 12345678,
      "symbol": "EURUSD",
      "type": "buylimit",
      "lots": 0.2,
      "open_price": 1.0835,
      "sl": 1.0815,
      "tp": 1.0875,
      "comment": "TV-signal | cid:e3b1c2d4e5"
    }
  }
}
```

Confirmation occurs when the same `cid` is found in messages or in the order’s `comment`.

---

## Troubleshooting

- **No confirmation**  
  Increase `confirmTimeoutMs`. Verify that `DWX_Orders.txt` and `DWX_Messages.txt` are written. Ensure the comment includes `cid:<hex>`.

- **Command files not created**  
  The client writes to the first free file among `0..49` and retries for `max_retry_command_seconds`. Check file permissions and EA removal of processed command files.

- **JSON parse errors**  
  Possible during EA writes. The client silently retries on the next poll.

- **Slow or network drives**  
  Increase `sleep_delay` to `0.010–0.020` to reduce churn.

---

## FAQ

**Can a card be removed immediately after `placeOrder()`?**  
No. Cards are removed after `execution:result` with `status:'ok'` (post-confirmation).

**Is synchronous ticket retrieval supported?**  
No. The ticket becomes available only after confirmation from the terminal.

**Where are EA-side errors visible?**  
In `DWX_Messages.txt` entries with `type:"ERROR"` and `reason`. These are propagated as rejections when the CID matches.

**Are modify/close operations supported with confirmation?**  
The same CID pattern can be applied to `MODIFY_ORDER` and `CLOSE_ORDER`. The current focus is `OPEN_ORDER`; extensions follow the same mechanism.

---

## License & Compatibility

- File names and behavior match the DWX Connect Python client (`dwx_client.py`).  
- The adapter is a thin integration layer; DWX Connect/EA licensing follows the original repository and license.
