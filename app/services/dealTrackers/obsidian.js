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
  }

  onPositionClosed({ ticker, tp, sp, status }) {
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
    const fileName = `${dateStr}. ${sanitizeFileName(ticker)}.md`;
    const filePath = path.join(targetDir, fileName);

    let content = template;
    content = content.replace(/^- Date::.*$/m, `- Date:: [[${dateStr}]]`);
    content = content.replace(/^- Tactics::.*$/m, `- Tactics:: #Tactics/InPlay`);
    content = content.replace(/^- Ticker::.*$/m, `-  Ticker:: [[${ticker}]]`);
    if (tp != null) content = content.replace(/^- Take Setup::.*$/m, `- Take Setup:: ${tp}`);
    if (sp != null) content = content.replace(/^- Stop Setup::.*$/m, `- Stop Setup:: ${sp}`);
    const statusLine = status === 'take' ? '- Status:: [[Result. Take]]' : '- Status:: [[Result. Stop]]';
    content = content.replace(/^- Status::.*$/m, statusLine);

    try {
      fs.writeFileSync(filePath, content);
    } catch (e) {
      console.error('Failed to write Obsidian note', e);
    }
  }
}

module.exports = { ObsidianDealTracker };
