import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOwnedData, ownedDataForEffect, beginDataEffect, completeDataEffect, summarizeDataLedger } from '../../scripts/browser-data-ledger.mjs';
import { validateBrowserOperation } from '../../scripts/browser-task.mjs';

test('markers are unique task records and preparation does not authorize or count a write',()=>{
  const ledger={items:[]};const first=prepareOwnedData(ledger,'item1','prepare');
  assert.equal(prepareOwnedData(ledger,'item1','again'),first);
  assert.notEqual(prepareOwnedData({items:[]},'item1','prepare').marker,first.marker);
  assert.throws(()=>prepareOwnedData(ledger,'../foreign','prepare'));
  assert.equal(summarizeDataLedger(ledger).possible_residuals,0);
  assert.equal(summarizeDataLedger(ledger).prepared_only,1);
  assert.equal(summarizeDataLedger(ledger).untracked_data,'not_assessed');
});

test('uncertain creation and cleanup cannot be replayed or reassigned to another record',()=>{
  const ledger={items:[]},row=prepareOwnedData(ledger,'item','prepare');
  const create={kind:'create',key:'item',record_target:{by:'css',value:'#one'}};
  const cleanup={...create,kind:'cleanup'};
  assert.throws(()=>ownedDataForEffect(ledger,cleanup));
  assert.throws(()=>ownedDataForEffect({items:[]},create));
  beginDataEffect(ownedDataForEffect(ledger,create),create,'create');
  completeDataEffect(row,create,false);
  assert.throws(()=>ownedDataForEffect(ledger,create));
  assert.throws(()=>ownedDataForEffect(ledger,cleanup));
  completeDataEffect(row,create,true);
  assert.throws(()=>ownedDataForEffect(ledger,{...cleanup,record_target:{by:'css',value:'#other'}}));
  beginDataEffect(ownedDataForEffect(ledger,cleanup),cleanup,'delete');
  completeDataEffect(row,cleanup,false);
  assert.throws(()=>ownedDataForEffect(ledger,cleanup));
  assert.equal(summarizeDataLedger(ledger).possible_residuals,1);
  completeDataEffect(row,cleanup,true);
  assert.equal(summarizeDataLedger(ledger).removed_from_view,1);
  assert.throws(()=>ownedDataForEffect(ledger,cleanup));
});

test('data metadata cannot add arbitrary operations or cleanup authorization fields',()=>{
  assert.doesNotThrow(()=>validateBrowserOperation({type:'data_prepare',request_id:'prepare',key:'item'}));
  const op={type:'click',request_id:'create',target:{by:'css',value:'#add'},data_effect:{kind:'create',key:'item',record_target:{by:'css',value:'#record'}}};
  assert.doesNotThrow(()=>validateBrowserOperation(op));
  assert.throws(()=>validateBrowserOperation({...op,data_effect:{...op.data_effect,authorized:true}}));
  assert.throws(()=>validateBrowserOperation({...op,type:'fill',value:'x'}));
  assert.throws(()=>validateBrowserOperation({...op,data_effect:{...op.data_effect,kind:'delete_all'}}));
});
