import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const target=process.argv[2];
if(!target) throw new Error('Provide an engineering fixture receipt path');
let submissions=0;
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>标题管理</title>
<style>body{font:16px system-ui;margin:48px;max-width:640px}label,input,button{display:block;margin:16px 0}input{padding:8px;width:300px}button{padding:8px 20px}p{min-height:24px}</style>
<h1>标题管理</h1><form><label for="title">标题</label><input id="title" name="title" autocomplete="off"><button type="submit">保存</button></form><p role="status" aria-live="polite"></p>
<script>document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.querySelector('input').value})});document.querySelector('[role=status]').textContent=(await r.json()).message;});</script></html>`;
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET' && req.url==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
  if(req.method==='GET' && req.url==='/state') {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({submissions,synthetic:true}));}
  if(req.method==='POST' && req.url==='/save') {
    let body='';for await(const chunk of req) {body+=chunk;if(body.length>4096){res.statusCode=413;return res.end();}}
    let value;try {value=JSON.parse(body);}catch{res.statusCode=400;return res.end();}
    submissions++;
    // Deliberate fixture defect: the documented 20-character maximum is not enforced.
    res.setHeader('Content-Type','application/json; charset=utf-8');
    return res.end(JSON.stringify({message:value.title?.trim()?'保存成功':'标题不能为空'}));
  }
  res.statusCode=404;res.end();
});
server.listen(0,'127.0.0.1',()=>{
  const receipt={pid:process.pid,url:`http://127.0.0.1:${server.address().port}/`,synthetic:true,started_at:new Date().toISOString()};
  mkdirSync(resolve(target,'..'),{recursive:true});writeFileSync(target,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
});
