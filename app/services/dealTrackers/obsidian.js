const fs = require('fs');
const path = require('path');
const { DealTracker } = require('./base');

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-');
}

class ObsidianDealTracker extends DealTracker {
  constructor(cfg = {}) {
    super();
    this.vaultPath = cfg.vaultPath;
    this.journalPath = cfg.journalPath || cfg.vaultPath;
    this.findJournalPath = cfg.findJournalPath;
  }

  shouldWrite(info = {}, opts = {}) {
    const ticker = info.symbol && info.symbol.ticker;
    const vault = this.vaultPath;
    const targetDir = this.journalPath;
    if (!vault || !targetDir) return false;
    const searchDirs = [this.findJournalPath || targetDir];
    if ((this.findJournalPath || targetDir) !== targetDir) searchDirs.push(targetDir);
    const dateStr = info.placingDate || new Date().toISOString().slice(0, 10);
    const baseName = `${dateStr}. ${sanitizeFileName(ticker || '')}`;
    let fileName = `${baseName}.md`;
    const criteria = Array.isArray(opts?.skipExisting) ? opts.skipExisting : [];
    const getProp = (obj, p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
    const canCheck = criteria.length > 0 && criteria.every(c => {
      const v = getProp(info, c.prop);
      return v != null && v !== '';
    });
    if (!canCheck) return true;
    let i = 1;
    while (searchDirs.some(dir => fs.existsSync(path.join(dir, fileName)))) {
      for (const dir of searchDirs) {
        const existingPath = path.join(dir, fileName);
        if (!fs.existsSync(existingPath)) continue;
        try {
          const existing = fs.readFileSync(existingPath, 'utf8');
          const found = criteria.every(c => existing.includes(`${c.field}: ${getProp(info, c.prop)}`));
          if (found) return false;
        } catch {}
      }
      fileName = `${baseName} (${i}).md`;
      i += 1;
    }
    return true;
  }

  async onPositionClosed(info = {}, opts = {}) {
    if (!this.shouldWrite(info, opts)) return;

    const criteria = Array.isArray(opts?.skipExisting) ? opts.skipExisting : [];
    const getProp = (obj, p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
    const canCheck = criteria.length > 0 && criteria.every(c => {
      const v = getProp(info, c.prop);
      return v != null && v !== '';
    });

    const { symbol, tp, sp, status, profit, commission, takePoints, stopPoints, side, tactic, tradeRisk, tradeSession, placingDate, moveActualEP, moveReverse } = info;
    const ticker = symbol && symbol.ticker;
    const vault = this.vaultPath;
    const targetDir = this.journalPath;
    const searchDirs = [this.findJournalPath || targetDir];
    if ((this.findJournalPath || targetDir) !== targetDir) searchDirs.push(targetDir);

    const templatePath = path.join(vault, 'z. Staff', 'Templates', 'Template. Deal.md');
    let template;
    try {
      template = fs.readFileSync(templatePath, 'utf8');
    } catch (e) {
      console.error('Obsidian template not found', e);
      return;
    }

    const dateStr = placingDate || new Date().toISOString().slice(0, 10);
    const baseName = `${dateStr}. ${sanitizeFileName(ticker || '')}`;
    let fileName = `${baseName}.md`;
    let filePath = path.join(targetDir, fileName);
    let i = 1;
    while (searchDirs.some(dir => fs.existsSync(path.join(dir, fileName)))) {
      fileName = `${baseName} (${i}).md`;
      filePath = path.join(targetDir, fileName);
      i += 1;
    }

    let content = template;
    content = content.replace(/^- Date::.*$/m, `- Date:: [[${dateStr}]]`);
    content = content.replace(/^- Tactics::.*$/m, `- Tactics:: ${tactic || '#Tactics/InPlay'}`);
    if (ticker) {
      content = content.replace(/^- Ticker::.*$/m, `- Ticker:: [[Ticker. ${ticker}]]`);
    }
    if (tp != null) content = content.replace(/^- Take Setup::.*$/m, `- Take Setup:: ${tp}`);
    if (sp != null) content = content.replace(/^- Stop Setup::.*$/m, `- Stop Setup:: ${sp}`);
    if (profit != null) {
      const rounded = Math.round(profit * 100) / 100;
      content = content.replace(/^- Trade Profit::.*$/m, `- Trade Profit:: ${rounded}`);
    }
    if (commission != null && commission !== 0) {
      const roundedCommission = Math.round(commission * 100) / 100;
      content = content.replace(/^- Trade Commissions::.*$/m, `- Trade Commissions:: ${roundedCommission}`);
    }
    if (takePoints != null && takePoints !== 0) {
      content = content.replace(/^- Take Points::.*$/m, `- Take Points:: ${takePoints}`);
    }
    if (stopPoints != null && stopPoints !== 0) {
      content = content.replace(/^- Stop Points::.*$/m, `- Stop Points:: ${stopPoints}`);
    }
    if (status === 'take') {
      content = content.replace(/^- Stop Points::.*$/m, '- Stop Points:: 0');
    } else if (status === 'stop') {
      content = content.replace(/^- Take Points::.*$/m, '- Take Points:: 0');
    }
    if (tradeSession != null && tradeSession !== 0) {
      content = content.replace(/^- Trade Session::.*$/m, `- Trade Session:: ${tradeSession}`);
    }
    if (side) {
      const dir = side === 'long' ? '[[Direction. Long]]' : '[[Direction. Short]]';
      content = content.replace(/^- Direction::.*$/m, `- Direction:: ${dir}`);
    }
    if (tradeRisk != null && tradeRisk !== 0) {
      const roundedRisk = Math.round(tradeRisk * 100) / 100;
      content = content.replace(/^- Trade Risk::.*$/m, `- Trade Risk:: ${roundedRisk}`);
    }
    if (moveActualEP != null && moveActualEP !== 0) {
      content = content.replace(/^- Move Actual EP::.*$/m, `- Move Actual EP:: ${moveActualEP}`);
    }
    if (moveReverse != null && moveReverse !== 0) {
      content = content.replace(/^- Move Reverse::.*$/m, `- Move Reverse:: ${moveReverse}`);
    }
    if (status === 'take') {
      content = content.replace(/^- Homework::.*$/m, '- Homework:: [[Analysis. Right Direction]]');
    }
    const statusLine = status === 'take' ? '- Status:: [[Result. Take]]' : '- Status:: [[Result. Stop]]';
    content = content.replace(/^- Status::.*$/m, statusLine);

    if (info.chart1D) {
      content = content.replace(/\t- 1D.*$/m, `\t- 1D ![[${info.chart1D}]]`);
    }
    if (info.chart5M) {
      content = content.replace(/\t- 5M.*$/m, `\t- 5M ![[${info.chart5M}]]`);
    }

    if (canCheck) {
      const front = ['---'];
      for (const c of criteria) front.push(`${c.field}: ${getProp(info, c.prop)}`);
      front.push('---', '');
      content = front.join('\n') + content;
    }

    try {
      fs.writeFileSync(filePath, content);
    } catch (e) {
      console.error('Failed to write Obsidian note', e);
    }
  }
}

module.exports = { ObsidianDealTracker };
