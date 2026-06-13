# MCP Service

This service exposes a local MCP endpoint for read-only data access from the running ISCC panel.

## Intentional Scope

- This MCP server is intended to be a data source by design.
- `get_deals_history` reads closed deal history from a brokerage provider.
- `get_price_bars` reads OHLCV bar history from a brokerage provider that implements `getHistoricBars`.
- It must not expose order placement, cancellation, position management, command execution, or generic brokerage passthrough tools.
- If execution over MCP is ever needed, build a separate MCP server for that purpose with its own explicit risk model, authentication, review, and operational safeguards.

Keeping data access and trade execution in separate MCP surfaces reduces the chance that a data-query client can accidentally or indirectly create live orders.

## Tools

### `get_deals_history`

Returns closed deal history for a provider.

Input:

```json
{
  "provider": "dwx",
  "from": "2026-06-10T00:00:00.000Z",
  "to": "2026-06-11T00:00:00.000Z",
  "symbol": "EURUSD",
  "magic": 42,
  "type": "buy",
  "entry": "out",
  "commentContains": "setup",
  "timeoutMs": 5000
}
```

`provider` is optional when the brokerage execution config has a default provider.

### `get_price_bars`

Returns OHLCV bars for one symbol/timeframe/range. The first implementation is DWX, which uses the DWX `GET_HISTORIC_DATA` command through the running adapter.

Input:

```json
{
  "provider": "dwx",
  "symbol": "EURUSD",
  "timeframe": "M1",
  "from": "2026-06-10T08:00:00.000Z",
  "to": "2026-06-10T09:00:00.000Z",
  "limit": 5000,
  "timeoutMs": 5000
}
```

Output:

```json
{
  "provider": "dwx",
  "symbol": "EURUSD",
  "timeframe": "M1",
  "from": "2026-06-10T08:00:00.000Z",
  "to": "2026-06-10T09:00:00.000Z",
  "count": 2,
  "bars": [
    {
      "time": "2026-06-10T08:00:00.000Z",
      "open": 1.1,
      "high": 1.2,
      "low": 1.0,
      "close": 1.15,
      "volume": 42,
      "raw": {}
    }
  ]
}
```

Notes:

- `from` and `to` are required ISO date/time strings and are inclusive.
- `timeframe` defaults to `M1` and is normalized to uppercase.
- `limit` is optional and capped at `5000`; responses are sorted oldest to newest.
- Providers that do not implement `getHistoricBars` return an unsupported-provider error.
