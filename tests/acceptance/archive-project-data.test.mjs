import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { inventory,archiveData,verifyArchive } from '../../scripts/archive-project-data.mjs';

test('archive preserves source bytes and excludes engine; standalone verification detects tampering',async t=>{
  const base=await realpath(await mkdtemp(resolve(tmpdir(),'qa-archive-')));t.after(()=>rm(base,{recursive:true,force:true}));
  const root=resolve(base,'engine'),target=resolve(base,'archive');
  await mkdir(resolve(root,'output/runs/sample/empty'),{recursive:true});await mkdir(resolve(root,'scripts'));
  const long=resolve(root,'output', 'long-directory-'.repeat(8),'nested-'.repeat(12));
  await mkdir(long,{recursive:true});await writeFile(resolve(long,'evidence.txt'),'long-path evidence');
  await writeFile(resolve(root,'output/runs/sample/result.json'),'{}');await writeFile(resolve(root,'scripts/engine.mjs'),'private engine');
  const original=await inventory(root);assert.equal(original.files.length,2);
  const result=await archiveData(root,target);assert.equal(result.status,'verified');
  assert.equal(await readFile(resolve(root,'output/runs/sample/result.json'),'utf8'),'{}');
  await assert.rejects(()=>archiveData(root,target),/already exists/);
  await assert.rejects(()=>archiveData(root,resolve(root,'archive')),/separate/);
  assert.equal((await verifyArchive(target)).files,2);
  await writeFile(resolve(target,'data/output/runs/sample/result.json'),'tamper');
  await assert.rejects(()=>verifyArchive(target),/verification failed/);
});

test('archive records directory links without traversing unrelated data',async t=>{
  const base=await realpath(await mkdtemp(resolve(tmpdir(),'qa-archive-link-')));t.after(()=>rm(base,{recursive:true,force:true}));
  const root=resolve(base,'engine'),outside=resolve(base,'outside');
  await mkdir(root);await mkdir(outside);await symlink(outside,resolve(root,'output'),'junction');
  await writeFile(resolve(outside,'private.txt'),'not in scope');
  const data=await inventory(root);assert.equal(data.links.length,1);assert.equal(data.files.length,0);
});
