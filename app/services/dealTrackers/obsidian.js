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
    this.chartComposer = cfg.chartImageComposer;
  }

  async onPositionClosed(info = {}, opts = {}) {
    const { symbol, tp, sp, status, profit, commission, takePoints, stopPoints, side, tactic, tradeRisk, tradeSession, placingDate } = info;
    const ticker = symbol && symbol.ticker;
    const vault = this.vaultPath;
    const targetDir = this.journalPath;
    if (!vault || !targetDir) return;
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

    const criteria = Array.isArray(opts?.skipExisting) ? opts.skipExisting : [];
    const getProp = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
    const canCheck = criteria.length > 0 && criteria.every(c => {
      const v = getProp(info, c.prop);
      return v != null && v !== '';
    });

    let i = 1;
    while (searchDirs.some(dir => fs.existsSync(path.join(dir, fileName)))) {
      if (canCheck) {
        for (const dir of searchDirs) {
          const existingPath = path.join(dir, fileName);
          if (!fs.existsSync(existingPath)) continue;
          try {
            const existing = fs.readFileSync(existingPath, 'utf8');
            const found = criteria.every(c => existing.includes(`${c.field}: ${getProp(info, c.prop)}`));
            if (found) return;
          } catch {}
        }
      }
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
    if (status === 'take') {
      content = content.replace(/^- Homework::.*$/m, '- Homework:: [[Analysis. Right Direction]]');
    }
    const statusLine = status === 'take' ? '- Status:: [[Result. Take]]' : '- Status:: [[Result. Stop]]';
    content = content.replace(/^- Status::.*$/m, statusLine);

    let chartFile = null;
    if (this.chartComposer && symbol && symbol.exchange && ticker && canCheck) {
      try {
        chartFile = this.chartComposer.compose(`${symbol.exchange}:${ticker}`);
      } catch (e) {
        console.error('chart compose failed', e);
      }
    }
    if (chartFile) {
      content = content.replace(/\t- 1D.*$/m, `\t- 1D ![[${chartFile}]]`);
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
