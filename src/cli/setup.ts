#!/usr/bin/env node
// =============================================================================
// @pmatrix/openclaw-monitor — CLI
// npx @pmatrix/openclaw-monitor setup
// ~/.pmatrix/config.json에 설정 작성 (openclaw.json은 스키마 검증으로 사용 불가)
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';

const PMATRIX_DIR = path.join(os.homedir(), '.pmatrix');
const CONFIG_PATH = path.join(PMATRIX_DIR, 'config.json');

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command !== 'setup') {
    console.log('Usage: npx @pmatrix/openclaw-monitor setup');
    console.log('       npx @pmatrix/openclaw-monitor setup --apiKey=YOUR_KEY');
    process.exit(1);
  }

  await runSetup();
}

async function runSetup(): Promise<void> {
  console.log('');
  console.log('[P-MATRIX] OpenClaw Monitor Setup');
  console.log('─────────────────────────────────');

  // Parse CLI args
  const args = process.argv.slice(3);
  let apiKey = '';
  let serverUrl = 'https://api.pmatrix.io';

  for (const arg of args) {
    if (arg.startsWith('--apiKey=')) {
      apiKey = arg.slice('--apiKey='.length);
    } else if (arg.startsWith('--serverUrl=')) {
      serverUrl = arg.slice('--serverUrl='.length);
    }
  }

  // Interactive prompt if no apiKey
  if (!apiKey) {
    console.log('');
    console.log('Get your API key from: https://app.pmatrix.io');
    console.log('');
    apiKey = await prompt('API Key: ');
  }

  if (!apiKey) {
    console.error('Error: API key is required.');
    process.exit(1);
  }

  // Ensure ~/.pmatrix/ directory exists
  if (!fs.existsSync(PMATRIX_DIR)) {
    fs.mkdirSync(PMATRIX_DIR, { recursive: true });
  }

  // Read existing config or start fresh
  let config: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Parse failure → start fresh
    }
  }

  config['serverUrl'] = serverUrl;
  config['apiKey'] = apiKey;

  // Auto-generate agentId if not already set
  if (!config['agentId']) {
    const shortId = crypto.randomBytes(6).toString('hex');
    config['agentId'] = `oc_${shortId}`;
  }

  // Enable data sharing (API key setup implies consent)
  config['dataSharing'] = true;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  const masked = apiKey.length > 8
    ? apiKey.slice(0, 8) + '*'.repeat(apiKey.length - 8)
    : '********';

  console.log('');
  console.log('Setup complete!');
  console.log(`  Server:   ${serverUrl}`);
  console.log(`  API Key:  ${masked}`);
  console.log(`  Agent ID: ${config['agentId']}`);
  console.log(`  Config:   ${CONFIG_PATH}`);
  console.log('');
  console.log('Next step: openclaw gateway');
  console.log('');
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exit(1);
});
