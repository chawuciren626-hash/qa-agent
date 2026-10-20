import { createRequire } from 'node:module';

// SheetJS's Node entry owns filesystem support; its ESM browser entry does not.
const require=createRequire(import.meta.url);
export default require('xlsx');
