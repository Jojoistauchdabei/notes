'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const mcpDir = path.join(root, 'mcp');
const mcpserverDir = path.join(root, 'mcpserver');
const distDir = path.join(root, 'dist');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Ensure mcpserver files are mirrored inside mcp for self-contained deployment
fs.copyFileSync(path.join(mcpserverDir, 'index.js'), path.join(mcpDir, 'mcpserver.js'));
fs.copyFileSync(path.join(mcpserverDir, 'content.js'), path.join(mcpDir, 'content.js'));

const tarPath = path.join(distDir, 'mcp-function.tar.gz');
execSync(`tar -czf "${tarPath}" -C "${mcpDir}" .`, { stdio: 'inherit' });

console.log(`MCP Appwrite Function built and packaged at: ${tarPath}`);
