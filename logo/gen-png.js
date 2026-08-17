const { execFileSync } = require('child_process');
const fs = require('fs');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dir = 'G:/AI-Agent/ZcodeRemote/zcode-idea-plugin/logo';
const variants = ['zcgui-window-soft'];
const sizes = [16, 32, 48, 64, 128, 256, 640];
fs.mkdirSync(dir + '/.tmp/profile', { recursive: true });
fs.mkdirSync(dir + '/png', { recursive: true });
let fail = 0;
for (const v of variants) {
  const svg = fs.readFileSync(dir + '/' + v + '.svg', 'utf8');
  for (const s of sizes) {
    const sized = svg.replace('<svg ', `<svg width="${s}" height="${s}" `);
    const htmlName = `${v}_${s}.html`;
    fs.writeFileSync(dir + '/.tmp/' + htmlName,
      `<!doctype html><body style="margin:0;padding:0">${sized}</body>`);
    const out = dir + '/png/' + `${v}_${s}.png`;
    try {
      execFileSync(edge, ['--headless', '--disable-gpu', '--hide-scrollbars',
        '--default-background-color=00000000',
        `--user-data-dir=${dir}/.tmp/profile`,
        `--screenshot=${out}`, `--window-size=${s},${s}`,
        'file:///' + dir + '/.tmp/' + htmlName],
        { stdio: 'pipe', timeout: 30000 });
      console.log('OK', `${v}_${s}.png`);
    } catch (e) { fail++; console.log('FAIL', `${v}_${s}.png`, String(e.message).slice(0, 120)); }
  }
}
console.log('done, fail=' + fail);
