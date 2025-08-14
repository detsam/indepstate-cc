const fs = require('fs');
const path = require('path');
const { DealTracker } = require('./base');

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-');
}

class ObsidianDealTracker extends DealTracker {
  onPositionClosed({ ticker, tp, sp, status }) {
    const vault = process.env.OBSIDIAN_INDEPSTATE_VAULT;
    if (!vault) return;

    const templatePath = path.join(vault, 'z. Staff', 'Templates', 'Template. Deal');
    let template;
    try {
      template = fs.readFileSync(templatePath, 'utf8');
    } catch (e) {
      console.error('Obsidian template not found', e);
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `${dateStr}. ${sanitizeFileName(ticker)}.md`;
    const filePath = path.join(vault, fileName);

    let content = template;
    content = content.replace(/^- Date::.*$/m, `- Date:: ${dateStr}`);
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
