// dwx_client.js — прямой порт Python dwx_client.py на Node.js
// Сохранены имена файлов, сигнатуры команд и поведение.
// Требования: Node 16+, права на чтение/запись в каталог MetaTrader .../MQLx/Files/DWX

const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');

class Mutex {
  constructor() { this._queue = []; this._locked = false; }
  async lock() {
    if (!this._locked) { this._locked = true; return () => this.unlock(); }
    return new Promise(resolve => this._queue.push(() => resolve(() => this.unlock())));
  }
  unlock() {
    const next = this._queue.shift();
    if (next) next(); else this._locked = false;
  }
}

class dwx_client {
  /**
   * @param {Object} opts
   * @param {Object} [opts.event_handler] — объект с колбэками: on_order_event, on_message, on_tick, on_bar_data, on_historic_data, on_historic_trades
   * @param {string} [opts.metatrader_dir_path=''] — путь до каталога MQL4/5/Files (родитель для подпапки DWX)
   * @param {number} [opts.sleep_delay=0.005] — задержка опроса файлов (сек)
   * @param {number} [opts.max_retry_command_seconds=10]
   * @param {boolean} [opts.load_orders_from_file=true]
   * @param {boolean} [opts.verbose=true]
   */
  constructor({
    event_handler = null,
    metatrader_dir_path = '',
    sleep_delay = 0.005,
    max_retry_command_seconds = 10,
    load_orders_from_file = true,
    verbose = true,
  } = {}) {
    this.event_handler = event_handler;
    this.sleep_delay = sleep_delay;
    this.max_retry_command_seconds = max_retry_command_seconds;
    this.load_orders_from_file = load_orders_from_file;
    this.verbose = verbose;
    this.command_id = 0;

    if (!fssync.existsSync(metatrader_dir_path)) {
      // поведение Python-версии: вывести и завершить процесс
      console.error('ERROR: metatrader_dir_path does not exist!');
      process.exit(1);
    }

    this.path_orders = path.join(metatrader_dir_path, 'DWX', 'DWX_Orders.txt');
    this.path_messages = path.join(metatrader_dir_path, 'DWX', 'DWX_Messages.txt');
    this.path_market_data = path.join(metatrader_dir_path, 'DWX', 'DWX_Market_Data.txt');
    this.path_bar_data = path.join(metatrader_dir_path, 'DWX', 'DWX_Bar_Data.txt');
    this.path_historic_data = path.join(metatrader_dir_path, 'DWX', 'DWX_Historic_Data.txt');
    this.path_historic_trades = path.join(metatrader_dir_path, 'DWX', 'DWX_Historic_Trades.txt');
    this.path_orders_stored = path.join(metatrader_dir_path, 'DWX', 'DWX_Orders_Stored.txt');
    this.path_messages_stored = path.join(metatrader_dir_path, 'DWX', 'DWX_Messages_Stored.txt');
    this.path_commands_prefix = path.join(metatrader_dir_path, 'DWX', 'DWX_Commands_');

    this.num_command_files = 50;

    this._last_messages_millis = 0;
    this._last_open_orders_str = '';
    this._last_messages_str = '';
    this._last_market_data_str = '';
    this._last_bar_data_str = '';
    this._last_historic_data_str = '';
    this._last_historic_trades_str = '';

    this.open_orders = {};
    this.account_info = {};
    this.market_data = {};
    this.bar_data = {};
    this.historic_data = {};
    this.historic_trades = {};

    this._last_bar_data = {};
    this._last_market_data = {};

    this.ACTIVE = true;
    this.START = false;

    this.lock = new Mutex();

    this.load_messages();
    if (this.load_orders_from_file) this.load_orders();

    // Запуск "потоков" (асинхронные циклы)
    this.messages_loop = this.check_messages();
    this.market_data_loop = this.check_market_data();
    this.bar_data_loop = this.check_bar_data();
    this.open_orders_loop = this.check_open_orders();
    this.historic_data_loop = this.check_historic_data();

    this.reset_command_ids();

    // no need to wait.
    if (this.event_handler === null) this.start();
  }

  /** START can be used to check if the client has been initialized. */
  start() { this.START = true; }

  /** Tries to read a file. */
  async try_read_file(file_path) {
    try {
      if (fssync.existsSync(file_path)) {
        return await fs.readFile(file_path, 'utf8');
      }
    } catch (e) {
      // can happen if mql writes to the file. don't print anything here unless verbose
      if (this.verbose && !(e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EPERM')) {
        console.warn(e);
      }
    }
    return '';
  }

  /** Tries to remove a file. */
  async try_remove_file(file_path) {
    for (let i = 0; i < 10; i++) {
      try {
        await fs.unlink(file_path);
        break;
      } catch (e) {
        if (!(e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EPERM')) {
          if (this.verbose) console.warn(e);
        }
        // retry
      }
    }
  }

  /** Regularly checks the file for open orders and triggers the event_handler.on_order_event() function. */
  async check_open_orders() {
    const delayMs = Math.max(1, Math.floor(this.sleep_delay * 1000));
    while (this.ACTIVE) {
      await sleep(delayMs);
      if (!this.START) continue;

      const text = await this.try_read_file(this.path_orders);
      if (text.trim().length === 0 || text === this._last_open_orders_str) continue;

      this._last_open_orders_str = text;
      let data;
      try { data = JSON.parse(text); } catch { continue; }

      let new_event = false;
      for (const order_id of Object.keys(this.open_orders)) {
        if (!(order_id in (data.orders || {}))) {
          new_event = true;
          if (this.verbose) console.log('Order removed: ', this.open_orders[order_id]);
        }
      }
      for (const [order_id, order] of Object.entries(data.orders || {})) {
        if (!(order_id in this.open_orders)) {
          new_event = true;
          if (this.verbose) console.log('New order: ', order);
        } else if (this.open_orders[order_id]?.open_time !== order.open_time) {
          new_event = true;
          if (this.verbose) console.log('Order updated: ', order);
        } else if (this.open_orders[order_id]?.pnl !== order.pnl) {
          new_event = true;
          if (this.verbose) console.log('Order updated: ', order);
        }
      }

      this.account_info = data.account_info || {};
      this.open_orders = data.orders || {};

      if (this.load_orders_from_file) {
        try { await fs.writeFile(this.path_orders_stored, JSON.stringify(data)); } catch {}
      }

      if (this.event_handler && new_event && typeof this.event_handler.on_order_event === 'function') {
        try { this.event_handler.on_order_event(); } catch {}
      }
    }
  }

  /** Regularly checks the file for messages and triggers the event_handler.on_message() function. */
  async check_messages() {
    const delayMs = Math.max(1, Math.floor(this.sleep_delay * 1000));
    while (this.ACTIVE) {
      await sleep(delayMs);
      if (!this.START) continue;

      const text = await this.try_read_file(this.path_messages);
      if (text.trim().length === 0 || text === this._last_messages_str) continue;

      this._last_messages_str = text;
      let data; try { data = JSON.parse(text); } catch { continue; }

      const keys = Object.keys(data).map(k => parseInt(k, 10)).sort((a, b) => a - b);
      for (const millis of keys) {
        if (Number.isFinite(millis) && millis > this._last_messages_millis) {
          this._last_messages_millis = millis;
          const message = data[String(millis)];
          if (this.event_handler && typeof this.event_handler.on_message === 'function') {
            try { this.event_handler.on_message(message); } catch {}
          }
        }
      }

      try { await fs.writeFile(this.path_messages_stored, JSON.stringify(data)); } catch {}
    }
  }

  /** Regularly checks the file for market data and triggers the event_handler.on_tick() function. */
  async check_market_data() {
    const delayMs = Math.max(1, Math.floor(this.sleep_delay * 1000));
    while (this.ACTIVE) {
      await sleep(delayMs);
      if (!this.START) continue;

      const text = await this.try_read_file(this.path_market_data);
      if (text.trim().length === 0 || text === this._last_market_data_str) continue;

      this._last_market_data_str = text;
      let data; try { data = JSON.parse(text); } catch { continue; }

      this.market_data = data || {};

      if (this.event_handler && typeof this.event_handler.on_tick === 'function') {
        for (const symbol of Object.keys(this.market_data)) {
          const cur = this.market_data[symbol];
          const prev = this._last_market_data[symbol];
          if (!prev || JSON.stringify(cur) !== JSON.stringify(prev)) {
            try { this.event_handler.on_tick(symbol, cur.bid, cur.ask); } catch {}
          }
        }
      }
      this._last_market_data = this.market_data;
    }
  }

  /** Regularly checks the file for bar data and triggers the event_handler.on_bar_data() function. */
  async check_bar_data() {
    const delayMs = Math.max(1, Math.floor(this.sleep_delay * 1000));
    while (this.ACTIVE) {
      await sleep(delayMs);
      if (!this.START) continue;

      const text = await this.try_read_file(this.path_bar_data);
      if (text.trim().length === 0 || text === this._last_bar_data_str) continue;

      this._last_bar_data_str = text;
      let data; try { data = JSON.parse(text); } catch { continue; }

      this.bar_data = data || {};

      if (this.event_handler && typeof this.event_handler.on_bar_data === 'function') {
        for (const st of Object.keys(this.bar_data)) {
          const cur = this.bar_data[st];
          const prev = this._last_bar_data[st];
          if (!prev || JSON.stringify(cur) !== JSON.stringify(prev)) {
            const idx = st.lastIndexOf('_');
            if (idx > 0) {
              const symbol = st.slice(0, idx);
              const time_frame = st.slice(idx + 1);
              try { this.event_handler.on_bar_data(symbol, time_frame, cur.time, cur.open, cur.high, cur.low, cur.close, cur.tick_volume); } catch {}
            }
          }
        }
      }
      this._last_bar_data = this.bar_data;
    }
  }

  /** Regularly checks the file for historic data and trades and triggers handlers. */
  async check_historic_data() {
    const delayMs = Math.max(1, Math.floor(this.sleep_delay * 1000));
    while (this.ACTIVE) {
      await sleep(delayMs);
      if (!this.START) continue;

      // historic data
      let text = await this.try_read_file(this.path_historic_data);
      if (text.trim().length > 0 && text !== this._last_historic_data_str) {
        this._last_historic_data_str = text;
        let data; try { data = JSON.parse(text); } catch { data = null; }
        if (data) {
          for (const st of Object.keys(data)) {
            this.historic_data[st] = data[st];
            if (this.event_handler && typeof this.event_handler.on_historic_data === 'function') {
              const idx = st.lastIndexOf('_');
              if (idx > 0) {
                const symbol = st.slice(0, idx);
                const time_frame = st.slice(idx + 1);
                try { this.event_handler.on_historic_data(symbol, time_frame, data[st]); } catch {}
              }
            }
          }
        }
        await this.try_remove_file(this.path_historic_data);
      }

      // historic trades
      text = await this.try_read_file(this.path_historic_trades);
      if (text.trim().length > 0 && text !== this._last_historic_trades_str) {
        this._last_historic_trades_str = text;
        let data; try { data = JSON.parse(text); } catch { data = null; }
        if (data) {
          this.historic_trades = data;
          if (this.event_handler && typeof this.event_handler.on_historic_trades === 'function') {
            try { this.event_handler.on_historic_trades(); } catch {}
          }
        }
        await this.try_remove_file(this.path_historic_trades);
      }
    }
  }

  /** Loads stored orders from file (in case of a restart). */
  async load_orders() {
    const text = await this.try_read_file(this.path_orders_stored);
    if (text.length > 0) {
      this._last_open_orders_str = text;
      try {
        const data = JSON.parse(text);
        this.account_info = data.account_info || {};
        this.open_orders = data.orders || {};
      } catch {}
    }
  }

  /** Loads stored messages from file (in case of a restart). */
  async load_messages() {
    const text = await this.try_read_file(this.path_messages_stored);
    if (text.length > 0) {
      this._last_messages_str = text;
      try {
        const data = JSON.parse(text);
        for (const k of Object.keys(data)) {
          const millis = parseInt(k, 10);
          if (Number.isFinite(millis) && millis > this._last_messages_millis) this._last_messages_millis = millis;
        }
      } catch {}
    }
  }

  /** API: subscribe_symbols */
  async subscribe_symbols(symbols) {
    this.send_command('SUBSCRIBE_SYMBOLS', (symbols || []).join(','));
  }

  /** API: subscribe_symbols_bar_data */
  async subscribe_symbols_bar_data(symbols = [['EURUSD', 'M1']]) {
    const data = symbols.map(st => `${st[0]},${st[1]}`);
    this.send_command('SUBSCRIBE_SYMBOLS_BAR_DATA', data.join(','));
  }

  /** API: get_historic_data */
  async get_historic_data({ symbol = 'EURUSD', time_frame = 'D1', start = Math.floor((Date.now() - 30*86400*1000)/1000), end = Math.floor(Date.now()/1000) } = {}) {
    const payload = [symbol, time_frame, parseInt(start, 10), parseInt(end, 10)];
    this.send_command('GET_HISTORIC_DATA', payload.join(','));
  }

  /** API: get_historic_trades */
  async get_historic_trades(lookback_days = 30) {
    this.send_command('GET_HISTORIC_TRADES', String(lookback_days));
  }

  /** API: open_order */
  async open_order(symbol = 'EURUSD', order_type = 'buy', lots = 0.01, price = 0, stop_loss = 0, take_profit = 0, magic = 0, comment = '', expiration = 0) {
    const data = [symbol, order_type, lots, price, stop_loss, take_profit, magic, comment, expiration];
    this.send_command('OPEN_ORDER', data.join(','));
  }

  /** API: modify_order */
  async modify_order(ticket, price = 0, stop_loss = 0, take_profit = 0, expiration = 0) {
    const data = [ticket, price, stop_loss, take_profit, expiration];
    this.send_command('MODIFY_ORDER', data.join(','));
  }

  /** API: close_order */
  async close_order(ticket, lots = 0) {
    const data = [ticket, lots];
    this.send_command('CLOSE_ORDER', data.join(','));
  }

  /** API: close_all_orders */
  async close_all_orders() {
    this.send_command('CLOSE_ALL_ORDERS', '');
  }

  /** API: close_orders_by_symbol */
  async close_orders_by_symbol(symbol) {
    this.send_command('CLOSE_ORDERS_BY_SYMBOL', symbol);
  }

  /** API: close_orders_by_magic */
  async close_orders_by_magic(magic) {
    this.send_command('CLOSE_ORDERS_BY_MAGIC', String(magic));
  }

  /** API: reset_command_ids */
  async reset_command_ids() {
    this.command_id = 0;
    await this.send_command('RESET_COMMAND_IDS', '');
    await sleep(500); // sleep to make sure it is read before other commands.
  }

  /**
   * Sends a command to the mql server by writing it to one of the command files.
   * Multiple command files are used to allow for fast execution of multiple commands in chronological order.
   */
  async send_command(command, content) {
    const unlock = await this.lock.lock();
    try {
      this.command_id = (this.command_id + 1) % 100000;
      const endTime = Date.now() + this.max_retry_command_seconds * 1000;

      while (Date.now() < endTime) {
        let success = false;
        for (let i = 0; i < this.num_command_files; i++) {
          const file_path = `${this.path_commands_prefix}${i}.txt`;
          if (!fssync.existsSync(file_path)) {
            try {
              await fs.writeFile(file_path, `<:${this.command_id}|${command}|${content}:>`);
              success = true;
              break;
            } catch (e) {
              if (this.verbose) console.warn(e);
            }
          }
        }
        if (success) break;
        await sleep(this.sleep_delay * 1000);
      }
    } finally {
      unlock();
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { dwx_client };
