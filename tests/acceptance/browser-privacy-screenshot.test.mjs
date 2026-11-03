import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePrivateScreenshot} from '../../scripts/browser-privacy.mjs';

test('screenshot masks sensitive fields without covering every ordinary image', async () => {
  const selectors=[];
  const page={
    evaluate:async()=>({values:[],mask_selectors:['span:nth-of-type(1)'],truncated:false}),
    locator:selector=>{selectors.push(selector);return {selector};},
    screenshot:async options=>{assert.equal(options.mask.length,2);},
  };
  const result=await capturePrivateScreenshot(page,'evidence.png',new Set());
  assert.equal(result.captured,true);
  assert.match(selectors[0],/input,textarea,select/);
  assert.doesNotMatch(selectors[0],/,img,/);
  assert.equal(selectors[1],'span:nth-of-type(1)');
});
