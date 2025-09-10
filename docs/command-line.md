# Command Line Service

The bottom of the application window includes a text input that accepts simple commands. The renderer forwards entered strings to the main process where `app/services/commandLine.js` resolves the command name and executes the corresponding handler.

Commands are case-insensitive and may define multiple names (aliases).

If a command fails (e.g. due to validation error), the entered text remains in the input field so you can quickly correct and retry. Successful commands clear the input.

## Shortcuts

`app/services/commandLine/config/command-line.json` may define a `shortcuts` array. When no text input is focused and a pressed key matches one of these commands, it executes immediately without waiting for `Enter`. When the command line input is focused, shortcuts are ignored and `Enter` must be used to run a command. Executing a shortcut does not move focus to the command line input.

The service manifest exports `hookRenderer(ipcRenderer)` which the renderer calls on startup. This hook wires the shortcut handler into the UI. Other services can also provide a `hookRenderer` function in their manifest to register renderer-side behavior.

## Commands

### add (alias: a)

```
add {ticker} {price} [sl] [tp] [risk]
```

Creates a new order card with the given ticker, entry price and stop loss. `sl` defaults to `10` points when omitted. `tp` and `risk` are optional. If `tp` is omitted, the card computes it automatically from the provided stop loss.

`sl` and `tp` accept either raw point values or absolute prices containing a decimal dot. When a dotted value is supplied, it is interpreted as a price level and converted to points relative to the entry price (same logic as the input field).

