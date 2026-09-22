import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deletionOrder,visitorFor,removeVisitor} from './visitors.mjs';
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
