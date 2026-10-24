import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demoAdminCredentials,nativeDemoLogin,interactiveMutationAllowed,interactiveAuthHeaders} from './interactive-policy.mjs';
import {resolveVisitorAuth,revokeVisitorSession,hash} from './visitors.mjs';

const host='demo.sellright.cc';
const csrf='cookie-csrf';
const tokenA='a'.repeat(64),tokenB='b'.repeat(64);
function fixture(){
  const rows=new Map();
  for(const [token,id]of [[tokenA,'visitor-a'],[tokenB,'visitor-b']])rows.set(hash(token),{
    id,slug:'demo-v-'+id,admin_id:'admin-'+id,
    config:{demo:true,demoSession:1,expiresAt:new Date(Date.now()+60000).toISOString(),csrfHash:hash(csrf)},
  });
  const statements=[];
  const query=async(sql,params)=>{
    statements.push({sql,params});
    if(sql.includes('FROM session se'))return {rows:rows.has(params[0])?[rows.get(params[0])]:[]};
    if(sql.startsWith('DELETE FROM session')){
      const row=rows.get(params[0]);
      if(row?.admin_id===params[1])rows.delete(params[0]);
    }
    return {rows:[]};
  };
  return {pool:{query,connect:async()=>({query,release(){}})},statements};
}

test('native login accepts only originless JSON API requests & bounded boolean returnToken',()=>{
  const headers={'content-type':'application/json; charset=utf-8'};
  assert.equal(nativeDemoLogin(headers,'/v1/admin/login','POST'),true);
  assert.equal(demoAdminCredentials({email:'admin',password:'admin',returnToken:true}),true);
  for(const change of [{origin:'https://'+host},{origin:'null'},{'sec-fetch-site':'same-origin'},{'content-type':'text/plain'},{'content-type':'application/jsonp'}])
    assert.equal(nativeDemoLogin({...headers,...change},'/v1/admin/login','POST'),false);
  assert.equal(nativeDemoLogin(headers,'/demo/session','POST'),false);
  assert.equal(nativeDemoLogin(headers,'/v1/admin/login','GET'),false);
  for(const returnToken of ['true',1,null,[],{}])assert.equal(demoAdminCredentials({email:'admin',password:'admin',returnToken}),false);
  assert.equal(demoAdminCredentials({email:'admin',password:'admin',returnToken:true,storeId:'visitor-b'}),false);
});

test('native bearer reads & writes bind to bearer visitor even beside another cookie or tenant header',async()=>{
  const {pool}=fixture();
  const headers={authorization:'Bearer '+tokenA,'x-store-slug':'demo-v-visitor-b'};
  const auth=await resolveVisitorAuth(pool,headers.authorization,tokenB);
  assert.equal(auth.bearer,true);
  assert.equal(auth.visitor.id,'visitor-a');
  assert.equal(auth.visitor.slug,'demo-v-visitor-a');
  assert.equal(interactiveMutationAllowed(headers,host,auth,undefined),true);
  assert.deepEqual(interactiveAuthHeaders(auth.visitor,csrf,auth.bearer),{authorization:'Bearer '+tokenA});
  const other=await resolveVisitorAuth(pool,'bearer '+tokenB,tokenA);
  assert.equal(other.visitor.id,'visitor-b');
  assert.equal(interactiveMutationAllowed({origin:'https://evil.invalid'},host,auth),false);
  assert.equal(interactiveMutationAllowed({origin:'null'},host,auth),false);
  assert.equal(interactiveMutationAllowed({origin:''},host,auth),false);
  assert.equal(interactiveMutationAllowed({origin:'https://'+host,'sec-fetch-site':'cross-site'},host,auth),false);
});

test('invalid, revoked & malformed explicit bearer never fall back to valid unrelated cookie',async()=>{
  const {pool}=fixture();
  for(const authorization of ['', 'Bearer', 'Bearer   ', 'Basic ignored', 'Bearer '+ 'c'.repeat(64), 'Bearer '+tokenA+' extra', ['Bearer '+tokenA]]){
    const auth=await resolveVisitorAuth(pool,authorization,tokenB);
    assert.equal(auth.bearer,true);
    assert.equal(auth.visitor,null,JSON.stringify(authorization));
    assert.equal(interactiveMutationAllowed({},host,auth),false);
  }
});

test('cookie mutations retain same-origin & stored CSRF hash validation',async()=>{
  const {pool}=fixture();
  const auth=await resolveVisitorAuth(pool,undefined,tokenA);
  assert.equal(auth.bearer,false);
  const headers={origin:'https://'+host,'x-csrf-token':csrf};
  assert.equal(interactiveMutationAllowed(headers,host,auth,csrf),true);
  assert.deepEqual(interactiveAuthHeaders(auth.visitor,csrf,false),{cookie:`sr_admin=${tokenA}; sr_csrf=${csrf}`,'x-csrf-token':csrf});
  assert.equal(interactiveMutationAllowed({'x-csrf-token':csrf},host,auth,csrf),false);
  assert.equal(interactiveMutationAllowed({...headers,origin:'https://evil.invalid'},host,auth,csrf),false);
  assert.equal(interactiveMutationAllowed(headers,host,auth),false);
  assert.equal(interactiveMutationAllowed({...headers,'x-csrf-token':'wrong'},host,auth,csrf),false);
  assert.equal(interactiveMutationAllowed({...headers,'x-csrf-token':'forged'},host,auth,'forged'),false);
});

test('logout revokes only authenticated session; other visitor & retained tenant survive',async()=>{
  const {pool,statements}=fixture();
  const auth=await resolveVisitorAuth(pool,'Bearer '+tokenA,tokenB);
  await revokeVisitorSession(pool,auth.visitor);
  assert.equal((await resolveVisitorAuth(pool,'Bearer '+tokenA,tokenB)).visitor,null);
  assert.equal((await resolveVisitorAuth(pool,'Bearer '+tokenB,undefined)).visitor.id,'visitor-b');
  const deletes=statements.filter(({sql})=>sql.startsWith('DELETE'));
  assert.deepEqual(deletes,[{sql:'DELETE FROM session WHERE token_hash=$1 AND admin_user_id=$2',params:[hash(tokenA),'admin-visitor-a']}]);
  assert.equal(statements.some(({sql})=>/DELETE FROM store|DELETE FROM admin_user/.test(sql)),false);
});
