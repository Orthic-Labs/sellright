import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deletionOrder,visitorFor,removeVisitor,provisionVisitor,demoRewardsConfig} from './visitors.mjs';
import {demoStoreId} from './safety.mjs';
test('cleanup deletes FK children first and permits same-table self references',()=>{
  assert.deepEqual(deletionOrder(['order','line','refund','collection'],[['line','order'],['refund','line'],['collection','collection']]),['refund','collection','line','order']);
  assert.throws(()=>deletionOrder(['a','b'],[['a','b'],['b','a']]),/cycle/);
});
test('untrusted visitor tokens never query the database',async()=>{
  for(const token of [undefined,'','guess',"' OR 1=1"]){assert.equal(await visitorFor({query:()=>{throw Error('Unexpected query');}},token),null);}
});
test('reset refuses the baseline before taking a database connection',async()=>{
  await assert.rejects(removeVisitor({},demoStoreId),/baseline/);
});
test('new demo tenants start with the points program at product defaults and reviews on, with no seeded review rows',async()=>{
  assert.deepEqual(demoRewardsConfig.loyalty,{enabled:true,earnRatePerDollar:1,pointsPerDollarOff:10,minRedeemPoints:0,maxRedeemPercentOfSubtotal:null,expiryDays:null});
  assert.equal(demoRewardsConfig.reviews.enabled,true);
  const statements=[];let storeConfig;
  const client={async query(sql,params){
    statements.push(sql);
    if(/INSERT INTO store\(/.test(sql))storeConfig=params[4];
    if(/count\(\*\)::int AS n FROM store/.test(sql))return {rows:[{n:0}]};
    if(/RETURNING id/.test(sql))return {rows:[{id:'00000000-0000-4000-8000-000000000000'}]};
    if(/INSERT INTO product_variant/.test(sql))return {rows:[{id:'00000000-0000-4000-8000-000000000001'}]};
    if(/INSERT INTO customer/.test(sql))return {rows:[{id:'00000000-0000-4000-8000-000000000002'}]};
    return {rows:[]};
  },release(){}};
  await provisionVisitor({connect:async()=>client});
  assert.deepEqual(storeConfig.loyalty,demoRewardsConfig.loyalty);
  assert.deepEqual(storeConfig.reviews,demoRewardsConfig.reviews);
  assert.equal(storeConfig.demo,true);
  // Reviews and ratings are never fabricated.
  assert.equal(statements.some(sql=>/product_review/i.test(sql)),false);
});
