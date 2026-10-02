#!/usr/bin/env node
// ============================================================
// MFMIR — полный сервер. Node.js 18+. Без внешних зависимостей.
// Все секреты — только из переменных окружения.
// ============================================================

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import tls from 'tls';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'mfmr-data.json');
const HTML_FILE = path.join(__dirname, 'index.html');

const PORT       = Number(process.env.PORT || 3000);
const BASE_URL   = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || '';

if(!JWT_SECRET || JWT_SECRET.length < 32){
  console.error('\n❌ JWT_SECRET не задан или <32 символов.');
  console.error('   Задай: openssl rand -hex 32\n');
  process.exit(1);
}

const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || process.env.SMTP_USER || ''
};

const TG = {
  token:  process.env.TG_BOT_TOKEN || '',
  chatId: process.env.TG_CHAT_ID || '',
  enabled: !!(process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID)
};

console.log('\n🔍 Окружение:');
console.log('   JWT_SECRET:  ' + (JWT_SECRET ? '✅' : '❌'));
console.log('   SMTP:        ' + (SMTP.host && SMTP.user && SMTP.pass ? '✅ '+SMTP.host : '⚠ консоль'));
console.log('   Telegram:    ' + (TG.enabled ? '✅' : '⚠ выкл'));

/* ============ TELEGRAM АУДИТ ============ */
async function tgAudit(event, details = {}){
  if(!TG.enabled) return;
  try{
    const esc = s => String(s).replace(/([_*\[\]`])/g,'\\$1').slice(0,300);
    const text = `🔔 *${esc(event)}*\n` +
      Object.entries(details).map(([k,v]) => `• ${esc(k)}: \`${esc(v)}\``).join('\n') +
      `\n🕒 ${new Date().toLocaleString('ru-RU')}`;
    await fetch(`https://api.telegram.org/bot${TG.token}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:TG.chatId, text, parse_mode:'Markdown', disable_web_page_preview:true })
    });
  }catch(e){ console.error('⚠ TG:', e.message); }
}

/* ============ БД ============ */
let DB = loadDB();
function loadDB(){
  try{ if(fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e){ console.error('⚠ БД:', e.message); }
  return seedDB();
}
function saveDB(){
  try{ fs.writeFileSync(DATA_FILE, JSON.stringify(DB,null,2)); }
  catch(e){ console.error('⚠ Сохранение:', e.message); }
}
function seedDB(){
  const owner = {
    id: crypto.randomUUID(),
    email: (process.env.OWNER_EMAIL || 'owner@mfmr.ru').toLowerCase(),
    login: process.env.OWNER_LOGIN || 'owner',
    nickname: process.env.OWNER_NICKNAME || 'Владелец',
    passwordHash: hashPassword(process.env.OWNER_PASSWORD || 'mfmir2026'),
    role: 'owner', roleName: 'Владелец',
    emailVerified: true, isTemporary: false,
    avatar: null, permOverrides: null,
    createdAt: Date.now()
  };
  const db = {
    users: [owner],
    tokens: [],
    roles: [
      { id:'user',  name:'Пользователь',       level:0,  color:'#9ca3af', perms:[] },
      { id:'agent', name:'Агент поддержки',    level:1,  color:'#3b82f6', perms:[] },
      { id:'admin', name:'Администратор',      level:2,  color:'#f59e0b', perms:[] },
      { id:'owner', name:'Владелец',           level:99, color:'#e0180f', perms:[] }
    ],
    news: [], screenshots: [], boards: { honor:[], shame:[] },
    guides: [], maps: [], packs: [],
    staffMessages: [], tickets: [], ticketSeq: 1,
    forum: { sections:[], topics:[] },
    recruitment: { enabled:true, forms:[], applications:[], interviewInfo:'', interviewChannel:'' },
    weeklyTop: [], lastPinnedWeek: null
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2));
  console.log('👑 Создан владелец:', owner.login);
  tgAudit('👑 Сервер MFMIR запущен — создан владелец', { login: owner.login });
  return db;
}

/* ============ КРИПТО ============ */
function hashPassword(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pw),salt,64).toString('hex')}`;
}
function verifyPassword(pw, stored){
  try{
    const [alg,salt,hash] = String(stored).split('$');
    if(alg!=='scrypt') return false;
    const t = crypto.scryptSync(String(pw),salt,64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(t,'hex'));
  }catch{ return false; }
}
function b64url(b){ return Buffer.from(b).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function b64urlD(s){ s=String(s).replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; return Buffer.from(s,'base64').toString('utf8'); }
function signJWT(p){
  const h = b64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const n = Math.floor(Date.now()/1000);
  const b = b64url(JSON.stringify({...p, iat:n, exp:n+7*24*3600}));
  const d = h+'.'+b;
  return d+'.'+b64url(crypto.createHmac('sha256',JWT_SECRET).update(d).digest());
}
function verifyJWT(t){
  try{
    const [h,p,s] = String(t).split('.');
    if(!h||!p||!s) return null;
    const e = b64url(crypto.createHmac('sha256',JWT_SECRET).update(h+'.'+p).digest());
    if(s.length!==e.length||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(e))) return null;
    const pl = JSON.parse(b64urlD(p));
    if(pl.exp && pl.exp < Math.floor(Date.now()/1000)) return null;
    return pl;
  }catch{ return null; }
}

/* ============ SMTP ============ */
function emailOf(f){ const m=String(f).match(/<([^>]+)>/); return m?m[1]:String(f).trim(); }
function wrap76(s){ const o=[]; for(let i=0;i<s.length;i+=76) o.push(s.slice(i,i+76)); return o.join('\r\n'); }
function buildMime({from,to,subject,text,html}){
  const bd = '----mfmr'+crypto.randomBytes(8).toString('hex');
  const mid = `<${crypto.randomBytes(16).toString('hex')}@mfmr>`;
  const dt = new Date().toUTCString();
  const se = '=?UTF-8?B?'+Buffer.from(subject||'','utf8').toString('base64')+'?=';
  const L = [`From: ${from}`,`To: ${to}`,`Subject: ${se}`,`Date: ${dt}`,`Message-ID: ${mid}`,'MIME-Version: 1.0'];
  if(html && text){
    L.push(`Content-Type: multipart/alternative; boundary="${bd}"`,'',`--${bd}`,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',wrap76(Buffer.from(text,'utf8').toString('base64')),`--${bd}`,'Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',wrap76(Buffer.from(html,'utf8').toString('base64')),`--${bd}--`);
  } else if(html){
    L.push('Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',wrap76(Buffer.from(html,'utf8').toString('base64')));
  } else {
    L.push('Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',wrap76(Buffer.from(text||'','utf8').toString('base64')));
  }
  return L.map(l => l.startsWith('.')?'.'+l:l).join('\r\n');
}
function smtpSend({to,subject,text,html}){
  return new Promise((resolve,reject)=>{
    const sock = tls.connect({host:SMTP.host,port:SMTP.port,servername:SMTP.host},()=>run().catch(reject));
    let buf=''; const waiting=[]; const to1 = setTimeout(()=>{try{sock.destroy();}catch{} reject(new Error('SMTP timeout'));},30000);
    function parse(){ let i; while((i=buf.indexOf('\r\n'))!==-1){ const l=buf.slice(0,i); buf=buf.slice(i+2); if(waiting.length) waiting.shift()(l); } }
    function read(){ return new Promise(r=>{waiting.push(r);parse();}); }
    function write(s){ sock.write(s+'\r\n'); }
    sock.on('data',c=>{buf+=c.toString('utf8');parse();});
    sock.on('error',e=>{clearTimeout(to1);reject(e);});
    async function readML(){ while(true){ const l=await read(); if(/^\d{3} /.test(l)) return; if(!/^\d{3}-/.test(l)) throw new Error('SMTP: '+l); } }
    async function expect(p){ const l=await read(); if(!l.startsWith(p)) throw new Error('SMTP ex '+p+': '+l); }
    async function run(){
      try{
        await expect('220');
        write('EHLO mfmr.local'); await readML();
        write('AUTH LOGIN'); await expect('334');
        write(Buffer.from(SMTP.user).toString('base64')); await expect('334');
        write(Buffer.from(SMTP.pass).toString('base64'));
        const a = await read(); if(!a.startsWith('235')) throw new Error('AUTH: '+a);
        write(`MAIL FROM:<${emailOf(SMTP.from)}>`); await expect('250');
        write(`RCPT TO:<${to}>`); await expect('250');
        write('DATA'); await expect('354');
        sock.write(buildMime({from:SMTP.from,to,subject,text,html})+'\r\n.\r\n');
        const d = await read(); if(!d.startsWith('250')) throw new Error('DATA: '+d);
        write('QUIT'); sock.end(); clearTimeout(to1); resolve({ok:true});
      }catch(e){ clearTimeout(to1); try{sock.destroy();}catch{} reject(e); }
    }
  });
}
async function sendMail({to,subject,text,html}){
  if(!SMTP.host || !SMTP.user || !SMTP.pass){
    console.log('\n📧 DEV MAIL →',to);
    console.log('   Subject:',subject);
    console.log('   Text:',(text||String(html||'').replace(/<[^>]+>/g,' ')).slice(0,150));
    return {dev:true};
  }
  try{ await smtpSend({to,subject,text,html}); console.log('📧 Отправлено →',to); }
  catch(e){ console.error('❌ SMTP:',e.message); throw e; }
}

/* ============ HTTP ============ */
function json(res,code,obj){
  const b = JSON.stringify(obj);
  res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(b)});
  res.end(b);
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let d='';
    req.on('data',c=>{d+=c;if(d.length>20*1024*1024){reject(new Error('too large'));req.destroy();}});
    req.on('end',()=>{if(!d)return resolve({});try{resolve(JSON.parse(d));}catch(e){reject(new Error('bad json'));}});
    req.on('error',reject);
  });
}
const findUser = q => DB.users.find(u => typeof q==='function' ? q(u) : (u.id===q||u.email===q||u.login===q));
const findByEmail = e => DB.users.find(u=>u.email===String(e||'').toLowerCase());
const findByLogin = l => DB.users.find(u=>u.login===l);
function authRequired(req){
  const h = req.headers.authorization||'';
  if(!h.startsWith('Bearer ')) return null;
  const d = verifyJWT(h.slice(7));
  return d ? findUser(d.id) : null;
}
function roleLvl(u){ if(!u) return -1; const r = DB.roles.find(x=>x.id===u.role); return r?r.level:-1; }
function can(u, perm){
  if(!u) return false;
  if(u.permOverrides && u.permOverrides[perm]!==undefined) return u.permOverrides[perm];
  const lvl = roleLvl(u);
  const MIN = {
    viewNews:0,viewScreenshots:0,likeScreenshots:0,commentScreenshots:0,submitScreenshots:0,
    viewGuides:0,viewMaps:0,viewPacks:0,viewForum:0,viewRecruit:0,supportChat:0,
    downloadMaps:1,supportReply:1,staffChat:1,
    publishNews:2,manageGuides:2,managePacks:2,moderateScreenshots:2,editBoard:2,manageUsers:2,
    manageRoles:99
  };
  return lvl >= (MIN[perm] ?? 999);
}
function requirePerm(u, perm){ if(!u) return {code:401,error:'Нет авторизации'}; if(!can(u,perm)) return {code:403,error:'Недостаточно прав'}; return null; }
const publicUser = u => ({
  id:u.id, email:u.email, login:u.login, nickname:u.nickname, role:u.role,
  roleName:u.roleName, avatar:u.avatar||null,
  isTemporary:!!u.isTemporary, permOverrides:u.permOverrides||null
});
const publicScreenshot = (s, uid) => ({
  id:s.id, author:s.author, img:s.img, place:s.place, stock:s.stock,
  status:s.status, approvedAt:s.approvedAt, date:s.date,
  likes:s.likes.length, dislikes:s.dislikes.length,
  likedByMe: s.likes.includes(uid), dislikedByMe: s.dislikes.includes(uid),
  comments: s.comments
});

/* ============ API ============ */
async function handleApi(req,res,pathname){
  const m = req.method;
  const url = new URL(req.url, BASE_URL);
  const q = Object.fromEntries(url.searchParams);

  /* ---------- AUTH ---------- */
  if(m==='POST' && pathname==='/api/auth/register'){
    const {email,login,password} = await readBody(req);
    if(!email||!password) return json(res,400,{error:'Заполните поля'});
    if(String(password).length<6) return json(res,400,{error:'Пароль минимум 6 символов'});
    if(findByEmail(email)) return json(res,409,{error:'Email уже зарегистрирован'});
    const code = String(Math.floor(100000+Math.random()*900000));
    DB.tokens = DB.tokens.filter(t=>t.expiresAt>Date.now());
    DB.tokens.push({
      id:crypto.randomUUID(),type:'verify_email',code,
      email:email.toLowerCase(), login:login||email.split('@')[0],
      passwordHash:hashPassword(password),
      expiresAt:Date.now()+30*60*1000, used:false
    });
    saveDB();
    let devCode;
    try{
      await sendMail({
        to: email,
        subject: 'MFMIR — код подтверждения',
        text: `Ваш код подтверждения MFMIR: ${code}`,
        html: `<div style="font-family:Arial;background:#000;color:#fff;padding:32px;border-radius:12px;max-width:520px">
          <h1 style="letter-spacing:4px;margin:0 0 8px">MF<span style="color:#e0180f">MIR</span></h1>
          <p style="color:#aaa">Код подтверждения:</p>
          <div style="font-size:38px;font-weight:900;letter-spacing:8px;padding:14px;background:#111;text-align:center;border-radius:8px;color:#e0180f">${code}</div>
          <p style="color:#888;font-size:13px;margin-top:16px">Код действует 30 минут.</p>
        </div>`
      });
    }catch(e){ devCode = code; }
    if(!SMTP.host) devCode = code;
    tgAudit('🆕 Регистрация',{email,login});
    return json(res,200,{ok:true, message:'Код отправлен на '+email, devCode});
  }

  if(m==='POST' && pathname==='/api/auth/confirm'){
    const {email,code} = await readBody(req);
    const tok = DB.tokens.find(t=>t.type==='verify_email'&&!t.used&&t.email===String(email||'').toLowerCase()&&t.code===String(code||''));
    if(!tok || tok.expiresAt < Date.now()) return json(res,400,{error:'Неверный или просроченный код'});
    const user = {
      id:crypto.randomUUID(),
      email:tok.email, login:tok.login, nickname:tok.login,
      passwordHash:tok.passwordHash,
      role:'user', roleName:'Пользователь',
      emailVerified:true, isTemporary:true,
      avatar:null, permOverrides:null,
      createdAt:Date.now()
    };
    DB.users.push(user); tok.used = true; saveDB();
    tgAudit('✅ Подтверждён',{email:user.email});
    return json(res,200,{
      ok:true,
      token: signJWT({id:user.id, role:user.role}),
      user: publicUser(user)
    });
  }

  if(m==='POST' && pathname==='/api/auth/login'){
    const {identifier,password} = await readBody(req);
    const u = findByEmail(identifier) || findByLogin(identifier);
    if(!u || !verifyPassword(password, u.passwordHash)){
      tgAudit('❌ Неудачный вход',{identifier, ip:req.socket.remoteAddress});
      return json(res,401,{error:'Неверный email/логин или пароль'});
    }
    tgAudit('🔑 Вход',{login:u.login, role:u.roleName});
    return json(res,200,{
      token: signJWT({id:u.id, role:u.role}),
      user: publicUser(u)
    });
  }

  if(m==='GET' && pathname==='/api/auth/me'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200, publicUser(u));
  }

  if(m==='POST' && pathname==='/api/auth/setup-profile'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const {nickname} = await readBody(req);
    if(!nickname || !String(nickname).trim()) return json(res,400,{error:'Ник обязателен'});
    u.nickname = String(nickname).trim();
    u.isTemporary = false;
    saveDB();
    return json(res,200,{ok:true, nickname:u.nickname});
  }

  if(m==='POST' && pathname==='/api/auth/profile'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const {nickname, avatar} = await readBody(req);
    if(nickname!==undefined) u.nickname = String(nickname).slice(0,60);
    if(avatar!==undefined) u.avatar = avatar ? String(avatar).slice(0,5000000) : null;
    saveDB();
    return json(res,200,{ok:true, user: publicUser(u)});
  }

  if(m==='POST' && pathname==='/api/auth/change-pass'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const {oldPass, newPass} = await readBody(req);
    if(!verifyPassword(oldPass, u.passwordHash)) return json(res,400,{error:'Неверный старый пароль'});
    if(String(newPass).length<6) return json(res,400,{error:'Пароль минимум 6 символов'});
    u.passwordHash = hashPassword(newPass);
    saveDB();
    tgAudit('🔑 Смена пароля',{login:u.login});
    return json(res,200,{ok:true});
  }

  /* ---------- ROLES ---------- */
  if(m==='GET' && pathname==='/api/roles'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{roles: DB.roles});
  }
  if(m==='POST' && pathname==='/api/roles'){
    const u = authRequired(req);
    const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const {name, level, color} = await readBody(req);
    if(!name) return json(res,400,{error:'Название обязательно'});
    const r = {id:'custom_'+Date.now(), name, level:Number(level)||0, color:color||'#fff', perms:[]};
    DB.roles.push(r); saveDB();
    tgAudit('🎭 Роль создана',{name});
    return json(res,200,{ok:true, roles: DB.roles});
  }
  if(m==='DELETE' && pathname.startsWith('/api/roles/')){
    const u = authRequired(req);
    const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const id = decodeURIComponent(pathname.slice('/api/roles/'.length));
    if(['owner','user','admin','agent'].includes(id)) return json(res,400,{error:'Системную роль удалить нельзя'});
    DB.roles = DB.roles.filter(r=>r.id!==id);
    saveDB();
    return json(res,200,{ok:true, roles: DB.roles});
  }

  if(m==='GET' && pathname==='/api/users'){
    const u = authRequired(req);
    const d = requirePerm(u,'manageUsers'); if(d) return json(res,d.code,{error:d.error});
    return json(res,200,{users: DB.users.map(publicUser)});
  }
  if(m==='POST' && pathname.match(/^\/api\/users\/[^/]+\/role$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'manageUsers'); if(d) return json(res,d.code,{error:d.error});
    const target = findUser(pathname.split('/')[3]);
    if(!target) return json(res,404,{error:'Пользователь не найден'});
    const {role} = await readBody(req);
    const r = DB.roles.find(x=>x.id===role);
    if(!r) return json(res,400,{error:'Роль не существует'});
    target.role = r.id; target.roleName = r.name;
    saveDB();
    tgAudit('🎭 Смена роли',{user:target.login, role:r.name});
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/users\/[^/]+\/perm$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'manageUsers'); if(d) return json(res,d.code,{error:d.error});
    const target = findUser(pathname.split('/')[3]);
    if(!target) return json(res,404,{error:'Не найден'});
    const {perm, value} = await readBody(req);
    if(!target.permOverrides) target.permOverrides = {};
    target.permOverrides[perm] = !!value;
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/users\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const id = pathname.split('/')[3];
    if(id===u.id) return json(res,400,{error:'Нельзя удалить себя'});
    const t = findUser(id);
    if(t && t.role==='owner') return json(res,400,{error:'Нельзя удалить владельца'});
    DB.users = DB.users.filter(x=>x.id!==id);
    saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- NEWS ---------- */
  if(m==='GET' && pathname==='/api/news'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{news: DB.news.slice().reverse()});
  }
  if(m==='POST' && pathname==='/api/news'){
    const u = authRequired(req);
    const d = requirePerm(u,'publishNews'); if(d) return json(res,d.code,{error:d.error});
    const {type,title,body,screenshot,id} = await readBody(req);
    if(!title || !body) return json(res,400,{error:'Заполните поля'});
    if(id){
      const n = DB.news.find(x=>x.id==id);
      if(!n) return json(res,404,{error:'Не найдено'});
      n.type=type||'NEWS'; n.title=title; n.body=body; n.screenshot=screenshot||null; n.edited=new Date().toLocaleDateString('ru');
    } else {
      DB.news.push({id:Date.now(),type:type||'NEWS',title,body,screenshot:screenshot||null,author:u.nickname,date:new Date().toLocaleDateString('ru')});
    }
    saveDB();
    tgAudit('📰 Новость',{author:u.nickname, title});
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/news\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'publishNews'); if(d) return json(res,d.code,{error:d.error});
    const id = pathname.split('/')[3];
    DB.news = DB.news.filter(n=>String(n.id)!==id);
    saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- SCREENSHOTS ---------- */
  if(m==='GET' && pathname==='/api/shots'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const isMod = can(u,'moderateScreenshots');
    const list = DB.screenshots
      .filter(s => s.status==='approved' || (isMod && s.status==='pending'))
      .map(s => publicScreenshot(s,u.id));
    const approved = DB.screenshots.filter(s=>s.status==='approved').map(s=>publicScreenshot(s,u.id));
    return json(res,200,{shots: list, approved});
  }
  if(m==='POST' && pathname==='/api/shots'){
    const u = authRequired(req);
    const d = requirePerm(u,'submitScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const {img, place, stock} = await readBody(req);
    if(!img || !String(img).startsWith('data:image/')) return json(res,400,{error:'Нужно изображение'});
    if(String(img).length > 8*1024*1024) return json(res,413,{error:'Файл >6 МБ'});
    DB.screenshots.push({
      id:Date.now(), author:u.nickname, img, place:place||'', stock:stock||'',
      status:'pending', approvedAt:null,
      likes:[], dislikes:[], comments:[],
      date:new Date().toLocaleDateString('ru')
    });
    saveDB();
    tgAudit('📸 Скриншот на модерацию',{author:u.nickname, place, stock});
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/shots\/[^/]+\/(approve|reject)$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'moderateScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[3]);
    const s = DB.screenshots.find(x=>x.id===id);
    if(!s) return json(res,404,{error:'Не найдено'});
    if(pathname.endsWith('/reject')){
      DB.screenshots = DB.screenshots.filter(x=>x.id!==id);
      tgAudit('❌ Скриншот отклонён',{mod:u.nickname});
    } else {
      s.status = 'approved'; s.approvedAt = Date.now();
      tgAudit('✅ Скриншот одобрен',{mod:u.nickname});
    }
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/shots\/[^/]+\/(like|dislike)$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'likeScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[3]);
    const s = DB.screenshots.find(x=>x.id===id);
    if(!s) return json(res,404,{error:'Не найдено'});
    const isLike = pathname.endsWith('/like');
    const f = isLike?'likes':'dislikes';
    const o = isLike?'dislikes':'likes';
    if(s[f].includes(u.id)) s[f] = s[f].filter(x=>x!==u.id);
    else { s[f].push(u.id); s[o] = s[o].filter(x=>x!==u.id); }
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/shots\/[^/]+\/comment$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'commentScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[3]);
    const s = DB.screenshots.find(x=>x.id===id);
    if(!s) return json(res,404,{error:'Не найдено'});
    const {text} = await readBody(req);
    if(!String(text||'').trim()) return json(res,400,{error:'Пусто'});
    s.comments.push({author:u.nickname, text:String(text).slice(0,1000), date:new Date().toLocaleString('ru')});
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/shots\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'moderateScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[3]);
    DB.screenshots = DB.screenshots.filter(x=>x.id!==id);
    DB.weeklyTop = (DB.weeklyTop||[]).filter(w=>w.screenshotId!==id);
    saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- WEEKLY TOP ---------- */
  if(m==='GET' && pathname==='/api/weekly'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{weeklyTop: DB.weeklyTop||[], lastPinnedWeek: DB.lastPinnedWeek||null});
  }
  if(m==='POST' && pathname==='/api/weekly/pin'){
    const u = authRequired(req);
    const d = requirePerm(u,'moderateScreenshots'); if(d) return json(res,d.code,{error:d.error});
    // простейшая реализация закрепления
    const approved = DB.screenshots.filter(s=>s.status==='approved');
    if(!approved.length) return json(res,400,{error:'Нет скриншотов'});
    const sorted = approved.slice().sort((a,b)=>(b.likes.length-b.dislikes.length)-(a.likes.length-a.dislikes.length));
    const b = sorted[0];
    const weekKey = (()=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+4-(d.getDay()||7));const ys=new Date(d.getFullYear(),0,1);return d.getFullYear()+'-W'+String(Math.ceil(((d-ys)/86400000+1)/7)).padStart(2,'0');})();
    DB.weeklyTop = DB.weeklyTop || [];
    DB.weeklyTop.push({
      id:Date.now(), weekKey, weekLabel:'Неделя '+weekKey.split('-W')[1],
      screenshotId:b.id, img:b.img, author:b.author, place:b.place, stock:b.stock,
      likes:b.likes.length, dislikes:b.dislikes.length,
      score:b.likes.length-b.dislikes.length,
      pinnedAt:new Date().toLocaleDateString('ru')
    });
    DB.lastPinnedWeek = weekKey;
    saveDB();
    tgAudit('🏆 Топ закреплён',{author:b.author});
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname==='/api/weekly'){
    const u = authRequired(req);
    const d = requirePerm(u,'moderateScreenshots'); if(d) return json(res,d.code,{error:d.error});
    DB.weeklyTop = []; DB.lastPinnedWeek = null; saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- BOARDS ---------- */
  if(m==='GET' && pathname==='/api/boards'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200, DB.boards);
  }
  if(m==='POST' && pathname.match(/^\/api\/boards\/(honor|shame)$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'editBoard'); if(d) return json(res,d.code,{error:d.error});
    const k = pathname.split('/')[3];
    const {nick, desc} = await readBody(req);
    if(!nick||!desc) return json(res,400,{error:'Заполните поля'});
    DB.boards[k].push({id:Date.now(), nick, desc, date:new Date().toLocaleDateString('ru')});
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/boards\/(honor|shame)\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'editBoard'); if(d) return json(res,d.code,{error:d.error});
    const [, , k, id] = pathname.split('/');
    DB.boards[k] = DB.boards[k].filter(e=>String(e.id)!==id);
    saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- GUIDES ---------- */
  if(m==='GET' && pathname==='/api/guides'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{guides: DB.guides});
  }
  if(m==='POST' && pathname==='/api/guides'){
    const u = authRequired(req);
    const d = requirePerm(u,'manageGuides'); if(d) return json(res,d.code,{error:d.error});
    const g = await readBody(req);
    if(!g.title) return json(res,400,{error:'Название обязательно'});
    if(g.id){
      const ex = DB.guides.find(x=>x.id==g.id);
      if(ex){ Object.assign(ex, g); saveDB(); return json(res,200,{ok:true}); }
    }
    g.id = Date.now(); g.author = u.nickname; g.date = new Date().toLocaleDateString('ru');
    DB.guides.push(g);
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/guides\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'manageGuides'); if(d) return json(res,d.code,{error:d.error});
    const id = pathname.split('/')[3];
    DB.guides = DB.guides.filter(x=>String(x.id)!==id);
    saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- MAPS ---------- */
  if(m==='GET' && pathname==='/api/maps'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{maps: DB.maps});
  }
  if(m==='POST' && pathname==='/api/maps'){
    const u = authRequired(req);
    const d = requirePerm(u,'managePacks'); if(d) return json(res,d.code,{error:d.error});
    const {name, desc, roles, extLink, fileDataUrl, fileName, fileSize, fileType} = await readBody(req);
    if(!name) return json(res,400,{error:'Название обязательно'});
    DB.maps.push({
      id:Date.now(), name, desc:desc||'', roles:roles||'Агент, Админ, Владелец',
      extLink:extLink||null, fileDataUrl:fileDataUrl||null, fileName:fileName||null,
      fileSize:fileSize||null, fileType:fileType||null,
      author:u.nickname, date:new Date().toLocaleDateString('ru')
    });
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/maps\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'managePacks'); if(d) return json(res,d.code,{error:d.error});
    const id = pathname.split('/')[3];
    DB.maps = DB.maps.filter(m=>String(m.id)!==id);
    saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- PACKS ---------- */
  if(m==='GET' && pathname==='/api/packs'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{packs: DB.packs});
  }
  if(m==='POST' && pathname==='/api/packs'){
    const u = authRequired(req);
    const d = requirePerm(u,'managePacks'); if(d) return json(res,d.code,{error:d.error});
    const p = await readBody(req);
    if(!p.name) return json(res,400,{error:'Название обязательно'});
    p.id = Date.now(); p.author = u.nickname; p.date = new Date().toLocaleDateString('ru');
    DB.packs.push(p);
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/packs\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'managePacks'); if(d) return json(res,d.code,{error:d.error});
    const id = pathname.split('/')[3];
    DB.packs = DB.packs.filter(p=>String(p.id)!==id);
    saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- STAFF CHAT ---------- */
  if(m==='GET' && pathname==='/api/staff'){
    const u = authRequired(req);
    const d = requirePerm(u,'staffChat'); if(d) return json(res,d.code,{error:d.error});
    return json(res,200,{messages: DB.staffMessages.slice(-300)});
  }
  if(m==='POST' && pathname==='/api/staff'){
    const u = authRequired(req);
    const d = requirePerm(u,'staffChat'); if(d) return json(res,d.code,{error:d.error});
    const {text} = await readBody(req);
    if(!String(text||'').trim()) return json(res,400,{error:'Пусто'});
    DB.staffMessages.push({
      id:Date.now(), userId:u.id, author:u.nickname,
      text:String(text).slice(0,2000),
      date:new Date().toLocaleTimeString('ru')
    });
    saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- TICKETS ---------- */
  if(m==='GET' && pathname==='/api/tickets'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const isMod = can(u,'supportReply');
    const kind = q.kind;
    let list = DB.tickets;
    if(kind) list = list.filter(t=>t.kind===kind);
    if(!isMod) list = list.filter(t=>t.userId===u.id);
    return json(res,200,{tickets: list.slice().sort((a,b)=>b.updated-a.updated)});
  }
  if(m==='POST' && pathname==='/api/tickets'){
    const u = authRequired(req);
    const d = requirePerm(u,'supportChat'); if(d) return json(res,d.code,{error:d.error});
    const {kind, subject, category, description, files} = await readBody(req);
    if(!subject || !description) return json(res,400,{error:'Заполните поля'});
    const t = {
      id: DB.ticketSeq++, kind: kind==='mapdev'?'mapdev':'support',
      userId:u.id, userName:u.nickname,
      subject, category:category||'Другое', description,
      files: Array.isArray(files) ? files.slice(0,6) : [],
      status:'Новая', created:Date.now(), updated:Date.now(),
      messages:[], agentId:null, agentName:null
    };
    DB.tickets.push(t);
    saveDB();
    tgAudit('🎫 Новый тикет #'+t.id,{user:u.nickname, kind:t.kind, subject});
    return json(res,200,{ok:true, id:t.id});
  }
  if(m==='POST' && pathname.match(/^\/api\/tickets\/[^/]+\/message$/)){
    const u = authRequired(req);
    const id = Number(pathname.split('/')[3]);
    const t = DB.tickets.find(x=>x.id===id);
    if(!t) return json(res,404,{error:'Тикет не найден'});
    if(!can(u,'supportReply') && t.userId!==u.id) return json(res,403,{error:'Нет доступа'});
    const {text, attach} = await readBody(req);
    const tx = String(text||'').trim();
    if(!tx && !(attach && attach.length)) return json(res,400,{error:'Пусто'});
    t.messages.push({
      userId:u.id, author:u.nickname, text:tx,
      date:Date.now(), attach:Array.isArray(attach)?attach.slice(0,6):[]
    });
    t.updated = Date.now();
    if(can(u,'supportReply') && !t.agentName){ t.agentId = u.id; t.agentName = u.nickname; }
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/tickets\/[^/]+\/status$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[3]);
    const t = DB.tickets.find(x=>x.id===id);
    if(!t) return json(res,404,{error:'Не найден'});
    const {status} = await readBody(req);
    const ok = ['Новая','В работе','Решена','Отклонена'];
    if(!ok.includes(status)) return json(res,400,{error:'Неверный статус'});
    t.status = status; t.updated = Date.now();
    if(!t.agentName){ t.agentId = u.id; t.agentName = u.nickname; }
    t.messages.push({userId:u.id, author:'Система', text:'Статус: «'+status+'»', date:Date.now(), attach:[]});
    saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- FORUM ---------- */
  if(m==='GET' && pathname==='/api/forum/sections'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{sections: DB.forum.sections});
  }
  if(m==='POST' && pathname==='/api/forum/sections'){
    const u = authRequired(req);
    const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const {icon, name, desc} = await readBody(req);
    if(!name) return json(res,400,{error:'Название обязательно'});
    DB.forum.sections.push({id:Date.now(), icon:icon||'💬', name, desc:desc||''});
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/forum\/sections\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[4]);
    DB.forum.sections = DB.forum.sections.filter(s=>s.id!==id);
    DB.forum.topics = DB.forum.topics.filter(t=>t.sectionId!==id);
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='GET' && pathname==='/api/forum/topics'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const sid = Number(q.sectionId);
    let list = DB.forum.topics;
    if(sid) list = list.filter(t=>t.sectionId===sid);
    return json(res,200,{topics: list});
  }
  if(m==='POST' && pathname==='/api/forum/topics'){
    const u = authRequired(req);
    const {sectionId, title, body} = await readBody(req);
    if(!sectionId || !title || !body) return json(res,400,{error:'Заполните поля'});
    const t = {
      id:Date.now(), sectionId:Number(sectionId), title, pinned:false, locked:false,
      views:0, author:u.nickname, authorId:u.id,
      created:Date.now(), lastActivity:Date.now(),
      posts:[{id:Date.now()+1, author:u.nickname, authorId:u.id, avatar:u.avatar||null,
              text:String(body).slice(0,20000), date:new Date().toLocaleString('ru')}]
    };
    DB.forum.topics.push(t);
    saveDB();
    return json(res,200,{ok:true, id:t.id});
  }
  if(m==='POST' && pathname.match(/^\/api\/forum\/topics\/[^/]+\/reply$/)){
    const u = authRequired(req);
    const id = Number(pathname.split('/')[4]);
    const t = DB.forum.topics.find(x=>x.id===id);
    if(!t) return json(res,404,{error:'Тема не найдена'});
    if(t.locked) return json(res,403,{error:'Тема закрыта'});
    const {text} = await readBody(req);
    if(!String(text||'').trim()) return json(res,400,{error:'Пусто'});
    t.posts.push({id:Date.now(), author:u.nickname, authorId:u.id, avatar:u.avatar||null,
                  text:String(text).slice(0,20000), date:new Date().toLocaleString('ru')});
    t.lastActivity = Date.now();
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/forum\/topics\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[4]);
    DB.forum.topics = DB.forum.topics.filter(t=>t.id!==id);
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/forum\/topics\/[^/]+\/(pin|lock)$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[4]);
    const t = DB.forum.topics.find(x=>x.id===id);
    if(!t) return json(res,404,{error:'Не найдена'});
    if(pathname.endsWith('/pin')) t.pinned = !t.pinned;
    else t.locked = !t.locked;
    saveDB();
    return json(res,200,{ok:true, topic:t});
  }

  /* ---------- RECRUITMENT ---------- */
  if(m==='GET' && pathname==='/api/recruit'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const isMod = can(u,'supportReply');
    const forms = DB.recruitment.forms;
    const apps = isMod ? DB.recruitment.applications : DB.recruitment.applications.filter(a=>a.userId===u.id);
    return json(res,200,{
      enabled: DB.recruitment.enabled,
      forms, applications: apps,
      interviewInfo: DB.recruitment.interviewInfo,
      interviewChannel: DB.recruitment.interviewChannel
    });
  }
  if(m==='POST' && pathname==='/api/recruit/toggle'){
    const u = authRequired(req);
    const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    DB.recruitment.enabled = !DB.recruitment.enabled;
    saveDB();
    return json(res,200,{ok:true, enabled: DB.recruitment.enabled});
  }
  if(m==='POST' && pathname==='/api/recruit/forms'){
    const u = authRequired(req);
    const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const f = await readBody(req);
    if(!f.name) return json(res,400,{error:'Название обязательно'});
    if(f.id){
      const ex = DB.recruitment.forms.find(x=>x.id==f.id);
      if(ex){ Object.assign(ex, f); saveDB(); return json(res,200,{ok:true}); }
    }
    f.id = Date.now(); f.open = true; f.author = u.nickname; f.date = new Date().toLocaleDateString('ru');
    DB.recruitment.forms.push(f);
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/recruit\/forms\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const id = pathname.split('/')[4];
    DB.recruitment.forms = DB.recruitment.forms.filter(f=>String(f.id)!==id);
    DB.recruitment.applications = DB.recruitment.applications.filter(a=>String(a.formId)!==id);
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/recruit\/forms\/[^/]+\/toggle$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[4]);
    const f = DB.recruitment.forms.find(x=>x.id===id);
    if(!f) return json(res,404,{error:'Не найдена'});
    f.open = !f.open;
    saveDB();
    return json(res,200,{ok:true, open:f.open});
  }
  if(m==='POST' && pathname==='/api/recruit/applications'){
    const u = authRequired(req);
    const {formId, answers} = await readBody(req);
    const f = DB.recruitment.forms.find(x=>x.id===formId);
    if(!f) return json(res,404,{error:'Анкета не найдена'});
    if(!f.open) return json(res,403,{error:'Анкета закрыта'});
    if(DB.recruitment.applications.find(a=>a.formId===formId && a.userId===u.id))
      return json(res,409,{error:'Вы уже заполняли'});
    const a = {
      id:Date.now(), formId, userId:u.id, userName:u.nickname,
      answers: answers||[], status:'На рассмотрении', date:Date.now()
    };
    DB.recruitment.applications.push(a);
    saveDB();
    tgAudit('📝 Заявка набора',{user:u.nickname, form:f.name});
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/recruit\/applications\/[^/]+\/status$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[4]);
    const a = DB.recruitment.applications.find(x=>x.id===id);
    if(!a) return json(res,404,{error:'Не найдена'});
    const {status} = await readBody(req);
    a.status = status;
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/recruit\/applications\/[^/]+$/)){
    const u = authRequired(req);
    const d = requirePerm(u,'manageUsers'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[4]);
    DB.recruitment.applications = DB.recruitment.applications.filter(a=>a.id!==id);
    saveDB();
    return json(res,200,{ok:true});
  }

  return json(res,404,{error:'Не найдено'});
}

/* ============ HTTP SERVER ============ */
const server = http.createServer(async (req,res) => {
  try{
    const url = new URL(req.url, BASE_URL);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
    if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }

    if(pathname==='/' || pathname==='/index.html'){
      if(!fs.existsSync(HTML_FILE)){
        res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});
        return res.end('index.html не найден рядом с server.js');
      }
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(fs.readFileSync(HTML_FILE,'utf8'));
    }
    if(pathname.startsWith('/api/')) return handleApi(req,res,pathname);

    res.writeHead(404); res.end('Not found');
  }catch(e){
    console.error('❌',e);
    tgAudit('💥 Ошибка',{message:e.message, url:req.url});
    try{ json(res,500,{error:'Внутренняя ошибка'}); }catch{}
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║           MFMIR сервер запущен               ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  URL:     ' + BASE_URL.padEnd(34) + '║');
  console.log('║  Порт:    ' + String(PORT).padEnd(34) + '║');
  console.log('║  SMTP:    ' + ((SMTP.host?'✅ '+SMTP.host:'⚠ в консоль')).padEnd(34) + '║');
  console.log('║  TG:      ' + ((TG.enabled?'✅ включён':'⚠ выключен')).padEnd(34) + '║');
  console.log('╚══════════════════════════════════════════════╝\n');
  tgAudit('🚀 Сервер MFMIR запущен',{url:BASE_URL});
});