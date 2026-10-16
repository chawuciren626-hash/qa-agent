import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const requireValue=(ok,message)=>{if(!ok) throw new Error(message);};
export const dataLedgerPath='execution/browser-data-ledger.json';
export const validDataKey=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value);

export function prepareOwnedData(ledger,key,requestId) {
  requireValue(validDataKey(key),'Use a short data key, not a product identifier or credential');
  const existing=ledger.items.find(row=>row.key===key);
  if(existing) return existing;
  const row={key,marker:`qa-${randomUUID().replaceAll('-','').slice(0,20)}`,status:'prepared',prepared_request_id:requestId,events:[]};
  ledger.items.push(row);return row;
}

export function ownedDataForEffect(ledger,effect) {
  const row=ledger.items.find(item=>item.key===effect.key);
  requireValue(row,'Prepare a marker in this browser task first');
  requireValue(effect.kind==='create'?row.status==='prepared':row.status==='created_observed','Do not repeat an attempted creation/cleanup or adopt pre-existing data');
  if(effect.kind==='cleanup') requireValue(isDeepStrictEqual(row.record_target,effect.record_target),'Cleanup must use the recorded single-record target');
  return row;
}

export function beginDataEffect(row,effect,requestId) {
  row.record_target=structuredClone(effect.record_target);
  row.status=effect.kind==='create'?'create_uncertain':'cleanup_uncertain';
  row.events.push({kind:effect.kind,request_id:requestId,status:row.status,at:new Date().toISOString()});
}

export function completeDataEffect(row,effect,observed) {
  if(observed) row.status=effect.kind==='create'?'created_observed':'removed_from_view';
  row.events.at(-1).status=row.status;
  row.events.at(-1).observed_at=new Date().toISOString();
  return {key:row.key,marker:row.marker,status:row.status,interpretation:'UI identity observation only; not database ownership or physical deletion proof. Cleanup never expands the user-authorized scope.'};
}

export function summarizeDataLedger(ledger) {
  const items=ledger.items ?? [];
  return {tracked:items.length,prepared_only:items.filter(r=>r.status==='prepared').length,
    removed_from_view:items.filter(r=>r.status==='removed_from_view').length,
    possible_residuals:items.filter(r=>['created_observed','create_uncertain','cleanup_uncertain'].includes(r.status)).length,
    untracked_data:'not_assessed',interpretation:'Markers cover opted-in records only. Absence from the view is not verified backend deletion; zero tracked residuals is not proof the environment is clean.'};
}
