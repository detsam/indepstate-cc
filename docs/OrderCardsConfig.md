# Order Cards Config (order-cards.json)

This file defines event sources and display options for order cards in the UI.

## Parameters

- `sources`: list of event sources (webhook, file, etc.).
- `defaultEquityStopUsd`: default stop value in USD for equity cards.
- `closedCardEventStrategy`: reaction to a new event for a ticker whose card is already closed (`ignore` or `revive`).

### Display options
- `showBidAsk`: boolean, default `false`. When `true`, the card header shows the Bid/Ask price pair next to the ticker and updates with quotes.
- `showSpread`: boolean, default `false`. When `true`, the right side of the header shows the spread in points in the `current/avg10/avg100` format and keeps the last 100 values. Spread values are shown only for cards in the "ready to send" state ("готово к отправке").

