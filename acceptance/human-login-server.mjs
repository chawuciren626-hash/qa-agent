import { createServer } from 'node:http';
let loggedIn=false,prepared=0;
const server=createServer(async(req,res)=>{
  res.setHeader('cache-control','no-store');
  if(req.url==='/state'){res.setHeader('content-type','application/json');res.end(JSON.stringify({loggedIn,prepared}));return;}
  if(req.method==='POST' && req.url==='/prepare'){prepared++;res.end('ok');return;}
  if(req.method==='POST' && req.url==='/fixture-confirm' && req.headers['x-qa-fixture-test']==='1'){loggedIn=true;res.end('ok');return;}
  if(req.method==='POST' && req.url==='/fixture-close' && req.headers['x-qa-fixture-test']==='1'){res.end('closed');server.close();return;}
  if(req.url!=='/'){res.writeHead(404);res.end();return;}
  res.setHeader('content-type','text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>人工登录续接工程验收</title><style>body{font:18px sans-serif;margin:40px}button{padding:12px}</style><h1>人工登录续接工程验收</h1><p>本页仅为本机合成测试，不连接业务系统。</p><button id="prepare" onclick="fetch('/prepare',{method:'POST'}).then(refresh)">准备一次</button><p>准备次数：<span id="count">0</span></p><p id="login">等待人工登录</p><script>async function refresh(){const s=await(await fetch('/state')).json();document.getElementById('count').textContent=s.prepared;document.getElementById('login').textContent=s.loggedIn?'已登录':'等待人工登录';}setInterval(refresh,500);refresh();</script></html>`);
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/`,synthetic:true})));
