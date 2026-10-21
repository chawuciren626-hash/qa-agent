import {verifyProductPayload} from '../scripts/product-payload-check.mjs';
if(process.argv.length!==3)throw Error('Usage: verify-payload.mjs <stage>');
console.log(JSON.stringify(verifyProductPayload(process.argv[2])));
