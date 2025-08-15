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
    this.skipExisting = Array.isArray(cfg.skipExisting) ? cfg.skipExisting : null;
  }

  onPositionClosed(info = {}) {
    const { ticker, tp, sp, status, profit, commission, takePoints, stopPoints } = info;
    const vault = this.vaultPath;
    const targetDir = this.journalPath;
    if (!vault || !targetDir) return;

    const templatePath = path.join(vault, 'z. Staff', 'Templates', 'Template. Deal.md');
    let template;
    try {
      template = fs.readFileSync(templatePath, 'utf8');
    } catch (e) {
      console.error('Obsidian template not found', e);
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const baseName = `${dateStr}. ${sanitizeFileName(ticker)}`;
    let fileName = `${baseName}.md`;
    let filePath = path.join(targetDir, fileName);

    const criteria = Array.isArray(this.skipExisting) ? this.skipExisting : [];
    const canCheck = criteria.length > 0 && criteria.every(c => info[c.prop] != null && info[c.prop] !== '');

    let i = 1;
    while (fs.existsSync(filePath)) {
      if (canCheck) {
        try {
          const existing = fs.readFileSync(filePath, 'utf8');
          const found = criteria.every(c => existing.includes(`${c.field}: ${info[c.prop]}`));
          if (found) return;
        } catch {}
      }
      fileName = `${baseName} (${i}).md`;
      filePath = path.join(targetDir, fileName);
      i += 1;
    }

    let content = template;
    content = content.replace(/^- Date::.*$/m, `- Date:: [[${dateStr}]]`);
    content = content.replace(/^- Tactics::.*$/m, `- Tactics:: #Tactics/InPlay`);
    content = content.replace(/^- Ticker::.*$/m, `-  Ticker:: [[${ticker}]]`);
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
    const statusLine = status === 'take' ? '- Status:: [[Result. Take]]' : '- Status:: [[Result. Stop]]';
    content = content.replace(/^- Status::.*$/m, statusLine);

    if (canCheck) {
      const front = ['---'];
      for (const c of criteria) front.push(`${c.field}: ${info[c.prop]}`);
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
