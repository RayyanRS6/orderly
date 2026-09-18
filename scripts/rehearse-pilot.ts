// Local-only concurrency rehearsal: fictional data, in-memory storage, no network.
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {MemoryRepository} from '../server/storage/memory';
import {handleTurn} from '../server/service';
import {createConversation} from '../src/domain/engine';
import {seedCompanies,seedProducts} from '../src/shared/seed';
import type {BotAction} from '../src/shared/types';
process.env.APP_MODE='demo';
process.env.ORDERLY_RUNTIME='';process.env.VERCEL='';
let externalAttempts=0;
globalThis.fetch=async()=>{externalAttempts++;throw Error('Network is forbidden in the local pilot rehearsal')};
const repo=new MemoryRepository(false);
const company={...structuredClone(seedCompanies[0]),botEnabled:false};
await repo.saveCompany(company);
const products=seedProducts.filter(p=>p.companyId===company.id);for(const p of products)await repo.saveProduct(p);
const customers=100;const concurrency=10;const durations:number[]=[];let replayed=0;
const start=performance.now();
for(let batch=0;batch<customers;batch+=concurrency){
 await Promise.all(Array.from({length:Math.min(concurrency,customers-batch)},async(_,i)=>{
  const n=batch+i;const begin=performance.now();
  let conversation=createConversation(company.id,`fixture-${n}`,'demo',new Date().toISOString());
  const actions:BotAction[]=[{type:'add_item',productId:products[0].id,quantity:1},{type:'set_details',customerName:`Fixture ${n}`,fulfillment:'pickup'},{type:'review'},{type:'confirm'}];
  let confirmationId='';
  for(const action of actions){const messageId=randomUUID();if(action.type==='confirm')confirmationId=messageId;const result=await handleTurn(repo,company,conversation,{messageId,text:action.type==='confirm'?'confirm':'fixture',action,now:new Date().toISOString()});conversation=result.conversation;if(action.type==='confirm'&&!result.order)throw Error('Fixture order did not submit');}
  await handleTurn(repo,company,conversation,{messageId:confirmationId,text:'confirm',action:{type:'confirm'},now:new Date().toISOString()});replayed++;
  durations.push(performance.now()-begin);
 }));
}
const orders=await repo.listOrders(company.id);const jobs=await repo.listCompanyJobs(company.id);const usage=await repo.listUsage(company.id);
if(orders.length!==customers||orders.some(o=>!o.sandbox)||jobs.length||usage.length||externalAttempts)throw Error('Pilot rehearsal invariants failed');
durations.sort((a,b)=>a-b);
const result={checkedAt:new Date().toISOString(),scope:'Local in-memory ordering service; not a production/provider load test',customers,concurrency,turns:customers*5,orders:orders.length,replaysIgnored:replayed,externalAttempts,queuedJobs:jobs.length,modelUsageRecords:usage.length,elapsedMs:Math.round(performance.now()-start),conversationP50Ms:Math.round(durations[Math.floor(durations.length*.5)]),conversationP95Ms:Math.round(durations[Math.floor(durations.length*.95)])};
await mkdir('docs/audit-assets-2026-09-18',{recursive:true});await writeFile('docs/audit-assets-2026-09-18/local-pilot-rehearsal.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
