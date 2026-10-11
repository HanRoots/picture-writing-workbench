import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(projectRoot, 'dist');
const packageRoot = path.join(distRoot, 'fc-package');
const zipPath = path.join(distRoot, 'picture-writing-workbench-fc.zip');

await rm(packageRoot, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(path.join(packageRoot, 'server'), { recursive: true });
await mkdir(path.join(packageRoot, 'src', 'lib'), { recursive: true });

await cp(path.join(projectRoot, 'server', 'index.mjs'), path.join(packageRoot, 'server', 'index.mjs'));
for (const filename of ['demoAi.js', 'defaults.js', 'gradingGuards.js', 'taskContract.js']) {
  await cp(path.join(projectRoot, 'src', 'lib', filename), path.join(packageRoot, 'src', 'lib', filename));
}

const sourcePackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
await writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
  name: 'picture-writing-workbench-api',
  version: sourcePackage.version,
  private: true,
  type: 'module',
  scripts: { 'start:fc': 'node server/index.mjs' },
}, null, 2)}\n`);

const zipped = spawnSync('/usr/bin/zip', ['-rq', zipPath, '.'], {
  cwd: packageRoot,
  stdio: 'inherit',
});
if (zipped.status !== 0) throw new Error('无法生成 FC ZIP 部署包');
console.log(`FC 部署包已生成：${zipPath}`);
