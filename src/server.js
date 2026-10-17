import http from 'node:http';import {planMission,validateTransition} from './core.js';import {storeFromEnv} from './store.js';
const port=Number(process.env.PORT||3000),token=process.env.CTO_ADMIN_TOKEN;
if(!token||token.length<24)throw Error('CTO_ADMIN_TOKEN (24+ chars) required');
const store=storeFromEnv();
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data))};
const server=http.createServer(async(req,res)=>{try{
 if(req.url==='/health'&&req.method==='GET')return send(res,200,{ok:true});
 if(req.headers.authorization!=='Bearer '+token)return send(res,401,{error:'Unauthorized'});
 if(req.url==='/api/missions'&&req.method==='GET')return send(res,200,await store.list());
 if(req.url==='/api/missions'&&req.method==='POST'){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536)throw Error('Body too large')}const {objective,project}=JSON.parse(raw);return send(res,201,await store.save(planMission(objective,project)));}
 const match=req.url?.match(/^\/api\/missions\/([a-f0-9-]+)\/status$/);
 if(match&&req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;const {status}=JSON.parse(raw);const missions=await store.list();const m=missions.find(x=>x.id===match[1]);if(!m)return send(res,404,{error:'Not found'});m.status=validateTransition(m.status,status);return send(res,200,await store.save(m));}
 send(res,404,{error:'Not found'});
 }catch(e){send(res,400,{error:e.message})}});
server.listen(port,()=>console.log('CTO API listening on '+port));
