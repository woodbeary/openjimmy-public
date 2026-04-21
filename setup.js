#!/usr/bin/env node
/**
 * OpenJimmy Setup Wizard
 * Interactive onboarding for iMessage Legacy plugin
 */

import { createInterface } from 'readline';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  step: (n, msg) => console.log(`\n${colors.bright}[${n}]${colors.reset} ${msg}`),
  dim: (msg) => console.log(`${colors.dim}${msg}${colors.reset}`)
};

const banner = `
${colors.cyan}╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   ${colors.bright}OpenJimmy${colors.cyan} - iMessage for OpenClaw               ║
║   ${colors.dim}Works on macOS 11+ (Big Sur → Sequoia)${colors.cyan}             ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝${colors.reset}
`;

async function checkPrerequisites() {
  log.step(1, 'Checking prerequisites...');
  
  // Check macOS
  try {
    const version = execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim();
    const major = parseInt(version.split('.')[0]);
    if (major >= 11) {
      log.success(`macOS ${version} detected`);
    } else {
      log.error(`macOS ${version} is not supported. Need macOS 11 (Big Sur) or later.`);
      return false;
    }
  } catch (e) {
    log.error('Not running on macOS. OpenJimmy only works on Mac.');
    return false;
  }
  
  // Check Node.js
  try {
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (major >= 18) {
      log.success(`Node.js ${nodeVersion} detected`);
    } else {
      log.error(`Node.js ${nodeVersion} is too old. Need Node.js 18+`);
      return false;
    }
  } catch (e) {
    log.error('Node.js not found');
    return false;
  }
  
  // Check iMessage database
  const chatDb = join(homedir(), 'Library/Messages/chat.db');
  if (existsSync(chatDb)) {
    log.success('iMessage database found');
  } else {
    log.error('iMessage database not found at ~/Library/Messages/chat.db');
    log.warn('Make sure Messages app has been used at least once on this Mac');
    return false;
  }
  
  // Check Full Disk Access
  log.info('Checking Full Disk Access...');
  try {
    execSync(`sqlite3 "${chatDb}" "SELECT 1 LIMIT 1"`, { encoding: 'utf8', stdio: 'pipe' });
    log.success('Full Disk Access is enabled');
  } catch (e) {
    log.error('Full Disk Access is NOT enabled for Terminal');
    console.log(`
${colors.yellow}To fix this:${colors.reset}
1. Open System Preferences → Security & Privacy → Privacy
2. Select "Full Disk Access" from the left sidebar
3. Click the lock icon and authenticate
4. Click "+" and add Terminal (or your terminal app)
5. Restart Terminal and run this setup again
`);
    return false;
  }
  
  return true;
}

async function installDependencies() {
  log.step(2, 'Installing dependencies...');
  
  try {
    // Check if node_modules exists
    if (existsSync(join(__dirname, 'node_modules', 'better-sqlite3'))) {
      log.success('Dependencies already installed');
      return true;
    }
    
    log.info('Running pnpm install...');
    execSync('pnpm install', { cwd: __dirname, stdio: 'inherit' });
    log.success('Dependencies installed');
    return true;
  } catch (e) {
    log.error(`Failed to install dependencies: ${e.message}`);
    return false;
  }
}

async function configureOpenClaw() {
  log.step(3, 'Configuring OpenClaw...');
  
  const openclawDir = join(homedir(), '.openclaw');
  const configPath = join(openclawDir, 'config.yaml');
  
  // Check if OpenClaw is installed
  let openclawInstalled = false;
  try {
    execSync('which openclaw', { encoding: 'utf8', stdio: 'pipe' });
    openclawInstalled = true;
    log.success('OpenClaw CLI found');
  } catch (e) {
    log.warn('OpenClaw CLI not found in PATH');
  }
  
  if (!openclawInstalled) {
    console.log(`
${colors.yellow}OpenClaw not installed.${colors.reset}

Install it first:
  ${colors.cyan}pnpm add -g openclaw${colors.reset}

Then run this setup again.
`);
    const cont = await ask('Continue anyway to generate config snippet? (y/n): ');
    if (cont.toLowerCase() !== 'y') {
      return false;
    }
  }
  
  // Get user's phone number
  console.log(`
${colors.bright}Phone Number Setup${colors.reset}
Enter your iMessage phone number (the one you want the bot to respond to).
Format: +1XXXXXXXXXX (include country code)
`);
  
  let phoneNumber = await ask('Your phone number: ');
  phoneNumber = phoneNumber.trim();
  
  if (!phoneNumber.startsWith('+')) {
    phoneNumber = '+1' + phoneNumber.replace(/\D/g, '');
    log.info(`Formatted as: ${phoneNumber}`);
  }
  
  // Generate config snippet
  const configSnippet = `
# Add this to your ~/.openclaw/config.yaml under 'channels:'
imessage-legacy:
  plugin: "${__dirname}"
  ownerNumbers:
    - "${phoneNumber}"
  # Optional: add more numbers that can message the bot
  # allowedNumbers:
  #   - "+1234567890"
`;

  console.log(`
${colors.bright}Configuration Snippet${colors.reset}
${colors.dim}─────────────────────${colors.reset}
${configSnippet}
${colors.dim}─────────────────────${colors.reset}
`);

  // Try to detect existing config
  if (existsSync(configPath)) {
    const existingConfig = readFileSync(configPath, 'utf8');
    
    if (existingConfig.includes('imessage-legacy:')) {
      log.warn('imessage-legacy already configured in config.yaml');
      const overwrite = await ask('Update the configuration? (y/n): ');
      if (overwrite.toLowerCase() !== 'y') {
        log.info('Skipping config update');
        return true;
      }
    }
    
    const auto = await ask('Add this to your config automatically? (y/n): ');
    if (auto.toLowerCase() === 'y') {
      try {
        // Simple append if channels section exists
        if (existingConfig.includes('channels:')) {
          // Remove existing imessage-legacy block if present
          let newConfig = existingConfig.replace(/\n\s*imessage-legacy:[\s\S]*?(?=\n\s*\w+:|$)/g, '');
          
          // Find channels section and add our config
          const channelsMatch = newConfig.match(/^channels:\s*$/m);
          if (channelsMatch) {
            const insertPos = channelsMatch.index + channelsMatch[0].length;
            const indent = '  ';
            const indentedSnippet = `\n${indent}imessage-legacy:\n${indent}  plugin: "${__dirname}"\n${indent}  ownerNumbers:\n${indent}    - "${phoneNumber}"`;
            newConfig = newConfig.slice(0, insertPos) + indentedSnippet + newConfig.slice(insertPos);
          }
          
          writeFileSync(configPath, newConfig);
          log.success('Config updated!');
        } else {
          // Append channels section
          const appendConfig = `\nchannels:\n  imessage-legacy:\n    plugin: "${__dirname}"\n    ownerNumbers:\n      - "${phoneNumber}"\n`;
          writeFileSync(configPath, existingConfig + appendConfig);
          log.success('Config updated!');
        }
      } catch (e) {
        log.error(`Failed to update config: ${e.message}`);
        log.info('Please add the snippet manually');
      }
    }
  } else {
    log.info('No existing config found. Please create ~/.openclaw/config.yaml');
  }
  
  return true;
}

async function testConnection() {
  log.step(4, 'Testing iMessage connection...');
  
  try {
    const Database = (await import('better-sqlite3')).default;
    const chatDb = join(homedir(), 'Library/Messages/chat.db');
    const db = new Database(chatDb, { readonly: true });
    
    // Test query
    const result = db.prepare(`
      SELECT COUNT(*) as count 
      FROM message 
      WHERE date > ?
    `).get((Date.now() - 7 * 24 * 60 * 60 * 1000) * 1000000 - 978307200000000000);
    
    log.success(`Database accessible - ${result.count} messages in last 7 days`);
    db.close();
    
    // Test AppleScript
    log.info('Testing AppleScript send capability...');
    try {
      execSync(`osascript -e 'tell application "Messages" to get name'`, { encoding: 'utf8', stdio: 'pipe' });
      log.success('AppleScript can communicate with Messages app');
    } catch (e) {
      log.warn('AppleScript test failed - you may need to allow automation permissions');
      console.log(`
${colors.yellow}If sending fails later:${colors.reset}
1. Go to System Preferences → Security & Privacy → Privacy → Automation
2. Allow Terminal (or your terminal) to control Messages
`);
    }
    
    return true;
  } catch (e) {
    log.error(`Connection test failed: ${e.message}`);
    return false;
  }
}

async function showNextSteps() {
  log.step(5, 'Setup complete!');
  
  console.log(`
${colors.green}${colors.bright}✓ OpenJimmy is ready!${colors.reset}

${colors.bright}Next steps:${colors.reset}

1. ${colors.cyan}Restart OpenClaw gateway:${colors.reset}
   openclaw gateway restart

2. ${colors.cyan}Send yourself a test message${colors.reset}
   Text your Mac's iMessage number

3. ${colors.cyan}Check logs if something's wrong:${colors.reset}
   tail -f ~/.openclaw/gateway.log

${colors.bright}Troubleshooting:${colors.reset}
- No response? Check Full Disk Access for Terminal
- Send fails? Allow Terminal → Messages in Automation settings
- Still stuck? https://github.com/woodbeary/openjimmy-public/issues

${colors.dim}Happy messaging! 🎉${colors.reset}
`);
}

async function main() {
  console.log(banner);
  
  try {
    if (!await checkPrerequisites()) {
      log.error('Prerequisites check failed. Please fix the issues above and try again.');
      process.exit(1);
    }
    
    if (!await installDependencies()) {
      log.error('Failed to install dependencies.');
      process.exit(1);
    }
    
    await configureOpenClaw();
    await testConnection();
    await showNextSteps();
    
  } catch (e) {
    log.error(`Setup failed: ${e.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
