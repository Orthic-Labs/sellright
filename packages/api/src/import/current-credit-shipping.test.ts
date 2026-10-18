import { describe, expect, it } from 'vitest';
import { migrationId } from './context.js';
import { orderEditStoredFingerprint } from '../orders/order-edit-stack.js';
import { calculatePromotionStack, type StackInput } from '../money/promotion-stack.js';
import { buildOrderPricingSnapshot, type OrderPricingSnapshotV1 } from '../money/pricing-snapshot.js';
import { currentShippingSourceFacts, readCurrentOrderPricingSnapshot, type OrdinaryUnitFacts } from '../money/current-credit-pricing.js';
import { creditReturnSnapshotDigest } from '../account-credit/edit-funding.js';
const ACCOUNT = 'cccccccc-0000-4000-8000-000000000002';
const PROMOTION = 'cccccccc-0000-4000-8000-000000000003';
const LINE = 'cccccccc-0000-4000-8000-000000000004';
const NEW = 'cccccccc-0000-4000-8000-000000000005';
const REDEEM = 'cccccccc-0000-4000-8000-000000000006';
const EDIT = 'cccccccc-0000-4000-8000-000000000007';
function stack(tax = 875, inclusive = false): StackInput {
  return { lines: [{ key: 'sku', quantity: 3, placedQuantity: 3, unitListPrice: 100, priceIncludesTax: inclusive, taxRateBps: tax }],
    promotions: [{ id: PROMOTION, code: 'CREDIT', kind: 'account_credit', scope: 'order', value: 0,
      priority: 0, sequence: 1, freeShipping: false, conditions: null, credit: { accountId: ACCOUNT, availableCents: 101 } }],
    couponCodes: ['CREDIT'], phase: 'PaymentSettled', currency: 'USD', pricesIncludeTax: inclusive,
    shipping: 50, shippingTaxRateBps: tax, shippingIncludesTax: inclusive, couponContext: { activeVerifications: [] } };
}
function snapshot(input: StackInput, ids = new Map([['sku', LINE]])) {
  const result = calculatePromotionStack(input);
  const ordinaryUnitFacts: OrdinaryUnitFacts = Object.fromEntries(result.lineSnapshots.map(l => [ids.get(l.lineKey)!, {
    sourceAdjustmentTotal: l.sourceAdjustmentTotal!, sourceAdjustmentDivisor: l.sourceAdjustmentDivisor!,
  }]));
  return { saved: buildOrderPricingSnapshot(input, result, ids), ordinaryUnitFacts };
}
describe('imported shipping ancestry', () => {
  it('keeps ordered surviving carrier custody after its preceding carrier loses its last active member', () => {
    const store=ACCOUNT,sourceKey='carrier-source',orderId=migrationId(store,sourceKey,'order','10');
    const a=migrationId(store,sourceKey,'order-line','40'),b=migrationId(store,sourceKey,'order-line','41');
    const rawLines=[{id:40,shippingLineId:11},{id:41,shippingLineId:12}].map(line=>({...line,orderId:10,quantity:1,orderPlacedQuantity:1,
      listPrice:100,listPriceIncludesTax:false,adjustments:[],taxLines:[]}));
    const financialLines=rawLines.map((line,index)=>({id:index===0?a:b,storeId:store,orderId,quantity:1,unitPrice:100,
      lineSubtotal:100,lineDiscount:0,lineTax:0,lineTotal:100,metadata:{vendure:{id:String(line.id)}}}));
    const payload={version:1,format:'retained-pg-jsonb-text-v1',sourceKey,sourceOrderId:'10',
      sourceOrderRecord:JSON.stringify({id:10,currencyCode:'USD',couponCodes:[],subTotal:200,subTotalWithTax:200,shipping:75,shippingWithTax:75}),
      header:{subTotal:'200',subTotalWithTax:'200',shipping:'75',shippingWithTax:'75'},
      channel:{sourceId:'1',projection:'pricing-v1',sourceRecord:JSON.stringify({id:1,defaultCurrencyCode:'USD',pricesIncludeTax:false,defaultTaxZoneId:null}),orderChannelRecord:JSON.stringify({orderId:10,channelId:1})},
      lines:rawLines.map((line,index)=>({sourceId:String(line.id),orderLineId:index===0?a:b,sourceRecord:JSON.stringify(line)})),
      shippingMethods:[{sourceId:'1',sourceRecord:JSON.stringify({id:1,code:'FIRST'})},{sourceId:'2',sourceRecord:JSON.stringify({id:2,code:'SECOND'})}],
      shippingLines:[11,12].map((id,index)=>({sourceId:String(id),sourceRecord:JSON.stringify({id,orderId:10,shippingMethodId:index+1,listPrice:50,
        listPriceIncludesTax:false,adjustments:[{amount:index===0?-20:-5}],taxLines:[]})})),surcharges:[]};
    const basis={...payload,sourceDigest:orderEditStoredFingerprint(payload)};
    const line=(key:string,quantity=1)=>({key,quantity,placedQuantity:1,unitListPrice:100,priceIncludesTax:false,taxRateBps:0});
    const input:StackInput={...stack(0),lines:[line(a),line(b)],promotions:[],couponCodes:[],shipping:75,
      retainedShipping:{sourceDigest:basis.sourceDigest,mode:'keep',lines:[{sourceId:'11',net:30,gross:30},{sourceId:'12',net:45,gross:45}],
        carriers:[{sourceId:'11',methodCode:'FIRST',lineKeys:[a]},{sourceId:'12',methodCode:'SECOND',lineKeys:[b]}]}};
    const ids=new Map([[a,a],[b,b]]),first=snapshot(input,ids).saved;
    const money=(s:OrderPricingSnapshotV1)=>({totals:structuredClone(s.totals),lines:s.lines.map(l=>({id:l.orderLineId,quantity:l.quantity,lineTotal:l.lineGross}))});
    const after=(s:OrderPricingSnapshotV1)=>({...money(s),currentPricing:s,currentPricingDigest:creditReturnSnapshotDigest(s)});
    const firstRow={id:EDIT,orderId,before:{...money(first),currentPricing:null,
      storedOrder:{id:orderId,storeId:store,currency:'USD',...first.totals},financialLines,
      importedPricingBasis:{kind:'vendure-order-edit-basis-v1',storeId:store,orderId,currency:'USD',sourceKey,sourceOrderId:'10',editBasisV1:basis}},
      after:after(first),settlement:{type:'none',status:'none'}};
    const next=(quantity:number,carrierIds:Array<'11'|'12'>=['12'],members:Record<string,string[]>={12:[b]})=>snapshot({...input,
      lines:[line(a,quantity),line(b)],shipping:carrierIds.reduce((sum,id)=>sum+(id==='11'?30:45),0),retainedShipping:{
        sourceDigest:creditReturnSnapshotDigest(first),mode:'recalculate-keep-promotions',
        lines:carrierIds.map(id=>({sourceId:id,net:id==='11'?30:45,gross:id==='11'?30:45})),
        repricedBasis:carrierIds.map(id=>({sourceId:id,amount:50,includesTax:false,taxRateBps:0})),
        carriers:carrierIds.map(id=>({sourceId:id,methodCode:id==='11'?'FIRST':'SECOND',lineKeys:members[id]??[a]}))}},ids).saved;
    const row=(s:OrderPricingSnapshotV1)=>({id:NEW,orderId,before:{...money(first),currentPricing:first},after:after(s),settlement:{type:'none',status:'none'}});
    const view=(s:OrderPricingSnapshotV1)=>readCurrentOrderPricingSnapshot(s,{currency:'USD',orderLines:s.lines.map(l=>({id:l.orderLineId,quantity:l.quantity})),mode:'settlement'})!;
    const second=next(0),sources=[firstRow,row(second)];
    expect(currentShippingSourceFacts(view(second),undefined,sources,{orderId})).toEqual({
      basis:[{sourceId:'12',amount:50,includesTax:false,taxRateBps:0}],adjustments:{12:-5},carriers:[{sourceId:'12',methodCode:'SECOND',lineKeys:[b]}]});
    const kept=snapshot({...input,lines:[line(a,0),line(b)],shipping:45,retainedShipping:{sourceDigest:creditReturnSnapshotDigest(second),mode:'keep',
      lines:[{sourceId:'12',net:45,gross:45}],carriers:[{sourceId:'12',methodCode:'SECOND',lineKeys:[b]}]}},ids).saved;
    const keptRow={id:REDEEM,orderId,before:{...money(second),currentPricing:second},after:after(kept),settlement:{type:'none',status:'none'}};
    expect(currentShippingSourceFacts(view(kept),undefined,[...sources,keptRow],{orderId}).adjustments).toEqual({12:-5});
    for (const forged of [next(1),next(1,['12','11'],{11:[a],12:[b]}),next(0,['12'],{12:[a]})])
      expect(()=>currentShippingSourceFacts(view(forged),undefined,[firstRow,row(forged)],{orderId})).toThrow(/carrier custody|membership transferred/);
  });
});
