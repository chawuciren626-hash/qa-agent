import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

// Cache compiled engine schemas only, never task data, approvals or execution verdicts.
export function schemaCache({limit=32}={}) {
  const cache=new Map();
  return path=>{
    const bytes=readFileSync(path),key=`v1:${createHash('sha256').update(bytes).digest('hex')}`;
    if(cache.has(key)) return cache.get(key);
    const ajv=new Ajv2020({allErrors:true,strict:false}),validate=ajv.compile(JSON.parse(bytes));
    if(cache.size>=limit) cache.delete(cache.keys().next().value);
    const compiled={version:1,sha256:key.slice(3),validate,errors:()=>ajv.errorsText(validate.errors,{separator:'; '})};
    cache.set(key,compiled);return compiled;
  };
}
