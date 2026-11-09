import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePrivateScreenshot, closeBrowserWithReceipt, privateBrowserError, browserLaunchGuidance} from '../../scripts/browser-privacy.mjs';

test('browser cleanup receipts distinguish missing handles, acknowledgements and failures',async()=>{
  assert.equal((await closeBrowserWithReceipt()).status,'no_browser_handle');
  const ok=await closeBrowserWithReceipt({close:async()=>{}});
  assert.equal(ok.status,'close_acknowledged');
  assert.equal(ok.process_exit_verified,false);
  const failed=await closeBrowserWithReceipt({close:async()=>{throw new Error('private-path token=synthetic-secret');}});
  assert.equal(failed.status,'close_failed');
  assert.equal(JSON.stringify(failed).includes('synthetic-secret'),false);
});

test('launch denial guidance preserves uncertainty and sandbox permissions',()=>{
  for(const message of ['spawn EPERM private-path','Mojo Access denied private-path']) {
    const diagnostic=privateBrowserError(new Error(message),'browser_launch');
    assert.equal(diagnostic.category,'browser_start_denied');
    const guidance=browserLaunchGuidance(diagnostic.category);
    assert.equal(guidance.next_action,'check_authorized_browser_backend');
    assert.match(guidance.retry_policy,/Do not retry outside the sandbox/);
    assert.equal(JSON.stringify({diagnostic,guidance}).includes('private-path'),false);
  }
  assert.notEqual(privateBrowserError(new Error('EPERM'),'navigation').category,'browser_start_denied');
});

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
