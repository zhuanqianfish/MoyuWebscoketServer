/**
 * 用无头 Chrome 打开指令服务器页并截图（开发期人工核对 UI）。
 * 用法：node tools/shot.js [输出名] [hash] [宽] [高]
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const CHROME = 'C:\\Users\\fish\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const [, , name = 'shot', hash = '', w = '1500', h = '950'] = process.argv;
const OUT = path.join(__dirname, '..', `${name}.png`);
const URL = `http://127.0.0.1:8801/web${hash}`;

const p = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--window-size=${w},${h}`, '--virtual-time-budget=9000',
  `--screenshot=${OUT}`, URL,
], { stdio: 'ignore' });
p.on('exit', (c) => console.log(c === 0 ? `已保存 ${OUT}` : `退出码 ${c}`));
