# Order Calculator Service

Centralizes order mathematics such as stop-loss points, take-profit targets and position sizing. The service is used by the renderer's order cards and the pending orders hub to keep calculations consistent.

## Usage

```javascript
const { OrderCalculator } = require('../app/services/orderCalculator');
const calc = new OrderCalculator({ tradeRules });
const stopPts = calc.stopPts({ tickSize, symbol, entryPrice, stopPrice, instrumentType });
const takePts = calc.takePts(stopPts);
const qty = calc.qty({ riskUsd, stopPts, tickSize, lot, instrumentType });
```

Passing `tradeRules` allows enforcement of minimum stop sizes through `MinStopPointsRule`.
