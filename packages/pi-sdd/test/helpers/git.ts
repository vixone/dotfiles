import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandTransport } from '../../src/beads.ts';
const exec = promisify(execFile);
export const transport: CommandTransport = { async run({command}) {
  try { const r = await exec('/bin/sh', ['-c', command], {timeout: 10000}); return {exitCode: 0, ...r}; }
  catch (e) { const r = e as Error & {stdout:string;stderr:string}; return {exitCode:1,stdout:r.stdout,stderr:r.stderr}; }
}};
export async function git(path:string, ...args:string[]) { return (await exec('git', ['-C',path,...args])).stdout.trim(); }
export async function fixture() {
  const root = await mkdtemp('/tmp/sdd fixture ');
  await mkdir(join(root,'src')); await mkdir(join(root,'.start/scenarios'),{recursive:true});
  for (const [p,s] of [['src/a.ts','a\n'],['src/b.ts','b\n'],['README.md','readme'],['.start/scenarios/secret.md','SENTINEL']]) await writeFile(join(root,p!),s!);
  await git(root,'init','-b','feature/demo'); await git(root,'add','.');
  await git(root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','baseline');
  const runs = await mkdtemp('/tmp/sdd runs '); return {root,runs};
}
