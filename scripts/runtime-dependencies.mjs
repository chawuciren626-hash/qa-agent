import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export function packageMetadata(root,name) {
  const require=createRequire(resolve(root,'package.json'));
  let dir=dirname(require.resolve(name));
  for(let i=0;i<6;i++) {
    const path=resolve(dir,'package.json');
    if(existsSync(path)) {const value=JSON.parse(readFileSync(path,'utf8'));if(value.name===name) return value;}
    const parent=dirname(dir);if(parent===dir) break;dir=parent;
  }
  throw new Error(`Package metadata unavailable: ${name}`);
}
