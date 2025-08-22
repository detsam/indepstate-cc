# Command Line Service

The bottom of the application window includes a text input that accepts simple commands. The renderer forwards entered strings to the main process where `app/services/commandLine.js` resolves the command name and executes the corresponding handler.

Commands are case-insensitive and may define multiple names (aliases).

If a command fails (e.g. due to validation error), the entered text remains in the input field so you can quickly correct and retry. Successful commands clear the input.

## Commands

### add (alias: a)

```
add {ticker} {price} {sl} {tp} {risk}
```

Creates a new order card with the given ticker, entry price and stop loss. `tp` and `risk` are optional. If `tp` is omitted, the card computes it automatically from the provided stop loss.

`sl` and `tp` accept either raw point values or prices containing a decimal dot. Dotted values are converted to integer points using the shared `digitsFallbackPoints` helper.

