#!/usr/bin/env node
// ============================================================
// MFMIR V2 — сервер с защитой от падений, простым входом, Gmail, Telegram
// Node.js 18+. Без внешних зависимостей.
// ============================================================

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

/* ============================================================
   🛡 ЗАЩИТА ОТ ПАДЕНИЙ
   ============================================================ */
process.on('uncaughtException', (err) => {
  console.error('\n💥 [UNCAUGHT]', new Date().toLocaleString('ru-RU'));
  console.error('   Message:', err.message);
  console.error('   Stack:', (err.stack||'').split('\n').slice(0,5).join('\n   '));
});
process.on('unhandledRejection', (reason) => {
  console.error('\n💥 [REJECTION]', new Date().toLocaleString('ru-RU'));
  console.error('   Reason:', reason && reason.message ? reason.message : reason);
});
process.on('SIGTERM', () => console.log('⚠️ SIGTERM — контейнер останавливается'));
process.on('SIGINT', () => console.log('⚠️ SIGINT — Ctrl+C'));

const START_TIME = Date.now();
setInterval(() => {
  const uptime = Math.floor((Date.now() - START_TIME) / 1000);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  console.log(`💓 Heartbeat — работает ${h}ч ${m}м | RAM: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} МБ`);
  try {
    if(typeof DB !== 'undefined' && DB.tokens){
      const before = DB.tokens.length;
      DB.tokens = DB.tokens.filter(t => t.expiresAt > Date.now());
      if(DB.tokens.length !== before){
        saveDB();
        console.log(`🧹 Очищено токенов: ${before - DB.tokens.length}`);
      }
    }
  } catch(e){}
}, 5 * 60 * 1000);

setInterval(() => {
  const used = process.memoryUsage().rss / 1024 / 1024;
  if(used > 900){
    console.log('⚠️ Память >900 МБ, принудительный выход');
    process.exit(1);
  }
}, 60 * 1000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ============ ПАРСЕР .env ============ */
(function loadEnv(){
  for(const n of ['.env','env','env.txt','Mfmir.env','mfmir.env']){
    try{
      const p = path.join(__dirname, n);
      if(!fs.existsSync(p)) continue;
      let c = 0;
      fs.readFileSync(p,'utf8').split(/\r?\n/).forEach(line => {
        line = line.trim();
        if(!line || line.startsWith('#')) return;
        const i = line.indexOf('=');
        if(i < 0) return;
        const k = line.slice(0,i).trim();
        let v = line.slice(i+1).trim();
        if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v = v.slice(1,-1);
        if(!process.env[k]){ process.env[k] = v; c++; }
      });
      console.log('📄 Конфиг:', n, '—', c, 'переменных');
      return;
    }catch(e){}
  }
  console.log('⚠ .env не найден');
})();

const DATA_FILE = path.join(__dirname, 'mfmr-data.json');
const HTML_FILE = path.join(__dirname, 'index.html');
const PORT       = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const BASE_URL   = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || '';

if(!JWT_SECRET || JWT_SECRET.length < 32){
  console.error('❌ JWT_SECRET не задан');
  process.exit(1);
}

const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN || '';
const TG_GROUP_ID   = String(process.env.TG_GROUP_ID || '');

console.log('\n🔍 Окружение:');
console.log('   JWT_SECRET:  ' + (JWT_SECRET ? '✅' : '❌'));
console.log('   Gmail API:   ' + (process.env.GMAIL_REFRESH_TOKEN ? '✅' : '⚠ нет'));
console.log('   TG бот:      ' + (TG_BOT_TOKEN ? '✅' : '⚠ нет'));
console.log('   TG группа:   ' + (TG_GROUP_ID ? '✅' : '⚠ нет'));

/* ============ TELEGRAM API ============ */
async function tgCall(method, body){
  if(!TG_BOT_TOKEN) return null;
  try{
    const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    return await r.json();
  }catch(e){ console.error('TG', method, e.message); return null; }
}

const escapeHtml = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/* ============ GMAIL (оставлен для возможной отправки уведомлений) ============ */
let gmailCache = { token:null, exp:0 };
async function getGmailToken(){
  if(gmailCache.token && gmailCache.exp > Date.now()+60000) return gmailCache.token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const d = await r.json();
  if(!d.access_token) throw new Error('Gmail: ' + JSON.stringify(d));
  gmailCache = { token:d.access_token, exp:Date.now()+(d.expires_in||3600)*1000 };
  return d.access_token;
}

async function sendMail({to, subject, text, html}){
  if(!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN){
    console.log('📧 DEV →', to, '|', subject);
    return { dev:true };
  }
  try{
    const token = await getGmailToken();
    const from = process.env.GMAIL_USER_EMAIL;
    const MIME = [
      `From: MFMIR <${from}>`,
      `To: ${to}`,
      `Subject: =?utf-8?B?${Buffer.from(subject||'').toString('base64')}?=`,
      'MIME-Version: 1.0','Content-Type: text/html; charset="UTF-8"','Content-Transfer-Encoding: base64','',
      Buffer.from(html||text||'').toString('base64')
    ].join('\r\n');
    const raw = Buffer.from(MIME).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({ raw })
    });
    if(!r.ok) throw new Error('Gmail: '+await r.text());
    console.log('📧 Отправлено →', to);
    return { ok:true };
  }catch(e){
    console.error('❌ Gmail:', e.message);
    throw e;
  }
}

/* ============ БД ============ */
let DB = loadDB();
function loadDB(){
  try{ if(fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e){ console.error('⚠ БД:', e.message); }
  return seedDB();
}
function saveDB(){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(DB,null,2)); }catch(e){} }
function seedDB(){
  const owner = {
    id: crypto.randomUUID(),
    email: (process.env.OWNER_EMAIL||'owner@mfmr.ru').toLowerCase(),
    login: process.env.OWNER_LOGIN||'owner',
    nickname: process.env.OWNER_NICKNAME||'Владелец',
    passwordHash: hashPassword(process.env.OWNER_PASSWORD||'mfmir2026'),
    role:'owner', roleName:'Владелец',
    emailVerified:true, isTemporary:false,
    avatar:null, permOverrides:null, createdAt:Date.now()
  };
  const db = {
    users:[owner], tokens:[],
    roles:[
      {id:'user',name:'Пользователь',level:0,color:'#9ca3af',perms:[]},
      {id:'agent',name:'Агент поддержки',level:1,color:'#3b82f6',perms:[]},
      {id:'admin',name:'Администратор',level:2,color:'#f59e0b',perms:[]},
      {id:'owner',name:'Владелец',level:99,color:'#e0180f',perms:[]}
    ],
    news:[], screenshots:[], boards:{honor:[],shame:[]},
    guides:[], maps:[], packs:[],
    staffMessages:[], tickets:[], ticketSeq:1,
    forum:{sections:[],topics:[]},
    recruitment:{enabled:true,forms:[],applications:[],interviewInfo:'',interviewChannel:''},
    weeklyTop:[], lastPinnedWeek:null,
    topics:{}, punishments:[], punishSeq:1
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2));
  console.log('👑 Владелец:', owner.login);
  return db;
}
if(!DB.punishments) DB.punishments = [];
if(!DB.punishSeq) DB.punishSeq = 1;
if(!DB.topics) DB.topics = {};

function hashPassword(pw){ const s = crypto.randomBytes(16).toString('hex'); return `scrypt$${s}$${crypto.scryptSync(String(pw),s,64).toString('hex')}`; }
function verifyPassword(pw, stored){
  try{
    const [a,s,h] = String(stored).split('$');
    if(a!=='scrypt') return false;
    const t = crypto.scryptSync(String(pw),s,64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(t,'hex'));
  }catch{ return false; }
}
const b64url = b => Buffer.from(b).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const b64urlD = s => { s=String(s).replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; return Buffer.from(s,'base64').toString('utf8'); };
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

function json(res,code,obj){
  const b = JSON.stringify(obj);
  res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(b)});
  res.end(b);
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let d='';
    req.on('data',c=>{d+=c;if(d.length>10*1024*1024){reject();req.destroy();}});
    req.on('end',()=>{if(!d)return resolve({});try{resolve(JSON.parse(d));}catch(e){reject();}});
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
  const MIN = {viewNews:0,viewScreenshots:0,likeScreenshots:0,commentScreenshots:0,submitScreenshots:0,viewGuides:0,viewMaps:0,viewPacks:0,viewForum:0,viewRecruit:0,supportChat:0,downloadMaps:1,supportReply:1,staffChat:1,publishNews:2,manageGuides:2,managePacks:2,moderateScreenshots:2,editBoard:2,manageUsers:2,manageRoles:99,managePunishments:2};
  return lvl >= (MIN[perm] ?? 999);
}
function requirePerm(u, perm){ if(!u) return {code:401,error:'Нет авторизации'}; if(!can(u,perm)) return {code:403,error:'Недостаточно прав'}; return null; }
const publicUser = u => ({id:u.id,email:u.email,login:u.login,nickname:u.nickname,role:u.role,roleName:u.roleName,avatar:u.avatar||null,isTemporary:!!u.isTemporary,permOverrides:u.permOverrides||null});
const publicScreenshot = (s,uid) => ({id:s.id,author:s.author,img:s.img,place:s.place,stock:s.stock,status:s.status,approvedAt:s.approvedAt,date:s.date,likes:s.likes.length,dislikes:s.dislikes.length,likedByMe:s.likes.includes(uid),dislikedByMe:s.dislikes.includes(uid),comments:s.comments,rejectReason:s.rejectReason||null});

/* ============ ТОПИКИ — с 4 отдельными для наказаний ============ */
const TOPIC_TEMPLATES = [
  { key: 'server',       name: '🖥 Сервер' },
  { key: 'support',      name: '📩 Поддержка' },
  { key: 'registration', name: '🆕 Регистрация' },
  { key: 'news',         name: '📰 Новости' },
  { key: 'packs',        name: '📦 Паки' },
  { key: 'maps',         name: '🗺 Карты' },
  { key: 'screenshots',  name: '📸 Скриншоты' },
  { key: 'tickets',      name: '🎫 Тикеты' },
  { key: 'moderation',   name: '⚙️ Модерация' },
  { key: 'punish_bans',  name: '🔨 Баны' },
  { key: 'punish_mutes', name: '🔇 Муты' },
  { key: 'punish_kicks', name: '👢 Кики' },
  { key: 'punish_warns', name: '⚠️ Варны' }
];

async function setupTopics(){
  if(!TG_BOT_TOKEN || !TG_GROUP_ID){
    console.log('🤖 TG: пропущено (нет токена или группы)');
    return;
  }
  if(!DB.topics) DB.topics = {};
  console.log('🤖 Настраиваю топики...');
  const existing = {};
  try{
    const r = await tgCall('getForumTopics', { chat_id: TG_GROUP_ID, limit: 100 });
    if(r && r.ok && r.result && Array.isArray(r.result.topics)){
      r.result.topics.forEach(t => { if(t.name) existing[t.name] = t.message_thread_id; });
    }
  }catch(e){}
  for(const tpl of TOPIC_TEMPLATES){
    if(DB.topics[tpl.key]){ console.log('  ✓ есть:', tpl.name, '=', DB.topics[tpl.key]); continue; }
    if(existing[tpl.name]){
      DB.topics[tpl.key] = existing[tpl.name];
      console.log('  ✓ найден:', tpl.name, '=', existing[tpl.name]);
      continue;
    }
    const r = await tgCall('createForumTopic', { chat_id: TG_GROUP_ID, name: tpl.name });
    if(r && r.ok && r.result){
      DB.topics[tpl.key] = r.result.message_thread_id;
      console.log('  + создан:', tpl.name, '=', r.result.message_thread_id);
    } else {
      console.error('  ✗ не удалось:', tpl.name, r && r.description);
    }
    await new Promise(res => setTimeout(res, 700));
  }
  saveDB();
  console.log('🤖 Топики готовы');
}

async function tgAudit(topicKey, text){
  if(!TG_BOT_TOKEN || !TG_GROUP_ID) return;
  const threadId = DB.topics[topicKey];
  const body = {
    chat_id: TG_GROUP_ID,
    text: String(text).slice(0,4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if(threadId) body.message_thread_id = threadId;
  await tgCall('sendMessage', body);
}

const audit = {
  server: (text) => tgAudit('server', `🖥 <b>Сервер</b>\n\n${text}`),
  support: (text) => tgAudit('support', `📩 <b>Заявка в поддержку</b>\n\n${text}`),
  registration: (text) => tgAudit('registration', `🆕 <b>Регистрация</b>\n\n${text}`),
  login: (text) => tgAudit('registration', `🔑 <b>Вход</b>\n\n${text}`),
  news: (text) => tgAudit('news', `📰 <b>Новость</b>\n\n${text}`),
  pack: (text) => tgAudit('packs', `📦 <b>Новый пак</b>\n\n${text}`),
  map: (text) => tgAudit('maps', `🗺 <b>Новая карта</b>\n\n${text}`),
  screenshot: (text) => tgAudit('screenshots', `📸 <b>Скриншот</b>\n\n${text}`),
  ticket: (text) => tgAudit('tickets', `🎫 <b>Тикет</b>\n\n${text}`),
  moderation: (text) => tgAudit('moderation', `⚙️ <b>Модерация</b>\n\n${text}`),
  punishment: (text, type) => {
    const topicKey = { ban:'punish_bans', mute:'punish_mutes', kick:'punish_kicks', warn:'punish_warns' }[type] || 'punish_bans';
    return tgAudit(topicKey, `${text}`);
  }
};

/* ============ НАКАЗАНИЯ ============ */
const PUNISH_TYPES = {
  ban:  { label: '🔨 Бан',  icon: '🔨' },
  kick: { label: '👢 Кик',  icon: '👢' },
  mute: { label: '🔇 Мут',  icon: '🔇' },
  warn: { label: '⚠️ Варн', icon: '⚠️' }
};

function fmtPunish(p){
  const t = PUNISH_TYPES[p.type] || { label: p.type, icon: '⚖️' };
  const from = new Date(p.fromDate).toLocaleDateString('ru-RU');
  const to = new Date(p.toDate).toLocaleDateString('ru-RU');
  const status = p.active ? '⏳ активно' : '✅ снято';
  return `${t.icon} <b>${t.label}</b> — ${escapeHtml(p.userName)}\n` +
    `📅 ${from} → ${to}\n` +
    `📝 ${escapeHtml(p.reason)}\n` +
    `👮 Выдал: ${escapeHtml(p.createdBy)}\n` +
    `📊 ${status}`;
}

function deactivateExpiredPunishments(){
  const now = Date.now();
  let changed = false;
  DB.punishments.forEach(p => {
    if(p.active && p.toDate <= now){ p.active = false; p.autoRemoved = true; changed = true; }
  });
  if(changed) saveDB();
}

function parseDuration(str){
  str = String(str||'').trim().toLowerCase();
  if(!str) return null;
  const m = str.match(/^(\d+)\s*([mhdwMy])$/);
  if(m){
    const n = Number(m[1]);
    const unit = { m: 60000, h: 3600000, d: 86400000, w: 604800000, M: 2592000000, y: 31536000000 }[m[2]];
    return n * unit;
  }
  const m2 = str.match(/^(\d+)\s*(минут|мин|час|ч|ден|дн|день|дня|дней|недел|месяц|год|лет)/i);
  if(m2){
    const n = Number(m2[1]);
    const unit = m2[2];
    if(/минут|мин/.test(unit)) return n * 60000;
    if(/час|^ч$/.test(unit)) return n * 3600000;
    if(/ден|дн/.test(unit)) return n * 86400000;
    if(/недел/.test(unit)) return n * 604800000;
    if(/месяц/.test(unit)) return n * 2592000000;
    if(/год|лет/.test(unit)) return n * 31536000000;
  }
  return null;
}

/* ============ КОМАНДЫ TELEGRAM ============ */
async function handleTgCommand(text, msg){
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace('/', '');
  const rest = parts.slice(1);
  const cmdMap = { 'бан':'ban','ban':'ban','кик':'kick','kick':'kick','мут':'mute','mute':'mute','варн':'warn','warn':'warn' };
  const unpunishCmd = ['снять','разбан','снять_наказание','unpunish'];

  if(unpunishCmd.includes(cmd)) return handleUnpunish(rest);
  if(!cmdMap[cmd]) return false;

  const type = cmdMap[cmd];
  if(rest.length < 2){
    await tgAudit('punish_bans',
      `❌ <b>Ошибка команды</b>\n` +
      `Формат: <code>/${cmd} @username СРОК причина</code>\n` +
      `Пример: <code>/${cmd} @ivan 7d читает</code>\n` +
      `Сроки: <code>10m</code>, <code>1h</code>, <code>3d</code>, <code>1w</code>, <code>1M</code>, <code>1y</code>`);
    return true;
  }
  const userName = rest[0].replace('@', '');
  let duration, reason;
  if(type === 'kick'){
    duration = 1000;
    reason = rest.slice(1).join(' ') || 'без причины';
  } else {
    const dur = parseDuration(rest[1]);
    if(!dur){
      await tgAudit('punish_bans', `❌ <b>Неверный срок</b>: <code>${escapeHtml(rest[1])}</code>`);
      return true;
    }
    duration = dur;
    reason = rest.slice(2).join(' ') || 'без причины';
  }
  const fromDate = Date.now();
  const toDate = fromDate + duration;
  const createdBy = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'Admin';
  const p = {
    id: DB.punishSeq++, type, userName, reason, fromDate, toDate,
    active: true, createdBy, createdAt: Date.now(), source: 'telegram'
  };
  DB.punishments.push(p);
  saveDB();
  const topicKey = { ban:'punish_bans', mute:'punish_mutes', kick:'punish_kicks', warn:'punish_warns' }[type] || 'punish_bans';
  await tgAudit(topicKey, `✅ <b>Наказание выдано</b>\n\n` + fmtPunish(p));
  return true;
}

async function handleUnpunish(args){
  const userName = (args[0]||'').replace('@','');
  if(!userName){
    await tgAudit('punish_bans', `❌ Укажи пользователя: <code>/снять @username</code>`);
    return true;
  }
  let count = 0;
  DB.punishments.forEach(p => {
    if(p.userName === userName && p.active){
      p.active = false; p.removedBy = 'Telegram'; p.removedAt = Date.now();
      count++;
    }
  });
  saveDB();
  if(count === 0){
    await tgAudit('punish_bans', `⚠️ У <b>${escapeHtml(userName)}</b> нет активных наказаний`);
  } else {
    await tgAudit('punish_bans', `✅ Снято <b>${count}</b> наказаний с <b>${escapeHtml(userName)}</b>`);
  }
  return true;
}

/* ============ TELEGRAM POLLING ============ */
let tgPolling = false;
async function tgPollLoop(){
  if(tgPolling) return;
  if(!TG_BOT_TOKEN){ console.log('🤖 TG: пропущено'); return; }
  tgPolling = true;
  console.log('🤖 TG-бот запущен (long polling)');
  let errorCount = 0;
  while(true){
    try{
      const off = (DB.tgOffset || 0) + 1;
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${off}&timeout=30`);
      const d = await r.json();
      if(d.ok && Array.isArray(d.result)){
        errorCount = 0;
        for(const upd of d.result){
          DB.tgOffset = upd.update_id; saveDB();
          const msg = upd.message || upd.channel_post;
          if(!msg || !msg.text) continue;
          const chatId = String(msg.chat.id);
          if(chatId !== TG_GROUP_ID) continue;
          const text = msg.text.trim();
          if(!text.startsWith('/')) continue;
          try{
            const handled = await handleTgCommand(text, msg);
            if(!handled) console.log('TG: неизвестная команда:', text.slice(0,40));
          }catch(e){ console.error('TG cmd:', e.message); }
        }
      } else if(!d.ok){
        errorCount++;
        if(errorCount > 10){
          console.error('🤖 TG: много ошибок, пауза 60 сек');
          await new Promise(r => setTimeout(r, 60000));
          errorCount = 0;
        } else {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }catch(e){
      errorCount++;
      console.error('🤖 TG polling error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
/* ============================================================
   API
   ============================================================ */
async function handleApi(req, res, pathname){
  const m = req.method;
  const url = new URL(req.url, BASE_URL);
  const q = Object.fromEntries(url.searchParams);

  /* ---------- AUTH: РЕГИСТРАЦИЯ (простая, без кода) ---------- */
  if(m==='POST' && pathname==='/api/auth/register'){
    const {email, password} = await readBody(req);
    if(!email || !password) return json(res,400,{error:'Введите email и пароль'});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res,400,{error:'Некорректный email'});
    if(String(password).length<6) return json(res,400,{error:'Пароль минимум 6 символов'});
    const em = email.toLowerCase().trim();
    if(findByEmail(em)) return json(res,409,{error:'Этот email уже зарегистрирован'});

    const login = em.split('@')[0] + '_' + Math.floor(Math.random()*9000+1000);
    const user = {
      id: crypto.randomUUID(), email: em, login,
      nickname: em.split('@')[0],
      passwordHash: hashPassword(password),
      role:'user', roleName:'Пользователь',
      emailVerified: true, isTemporary: true,
      avatar: null, permOverrides: null, createdAt: Date.now()
    };
    DB.users.push(user);
    saveDB();
    audit.registration(`Email: <code>${escapeHtml(user.email)}</code>`);
    return json(res,200,{
      ok:true,
      token: signJWT({id:user.id, role:user.role}),
      user: publicUser(user)
    });
  }

  /* ---------- AUTH: ВХОД (простой, без кода) ---------- */
  if(m==='POST' && pathname==='/api/auth/login'){
    const {identifier, password} = await readBody(req);
    const u = findByEmail(identifier) || findByLogin(identifier);
    if(!u || !verifyPassword(password, u.passwordHash)){
      audit.login(`❌ Неудачная попытка\nЛогин: <code>${escapeHtml(identifier)}</code>`);
      return json(res,401,{error:'Неверный email/логин или пароль'});
    }
    const now = Date.now();
    const ban = (DB.punishments||[]).find(p => p.active && p.toDate > now && p.type === 'ban' &&
      (p.userName === u.login || p.userName === u.nickname || p.userName === u.email));
    if(ban){
      const until = new Date(ban.toDate).toLocaleDateString('ru-RU');
      return json(res,403,{error:`Вы забанены до ${until}. Причина: ${ban.reason}`});
    }
    audit.login(`✅ Вход: <b>${escapeHtml(u.nickname||u.login)}</b>`);
    return json(res,200,{
      token: signJWT({id:u.id, role:u.role}),
      user: publicUser(u)
    });
  }

  /* ---------- AUTH: ME / PROFILE / PASS ---------- */
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
    u.nickname = String(nickname).trim(); u.isTemporary = false; saveDB();
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
    u.passwordHash = hashPassword(newPass); saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- МОИ ЗАЯВКИ (для личного кабинета) ---------- */
  if(m==='GET' && pathname==='/api/me/tickets'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const mine = DB.tickets.filter(t => t.userId === u.id);
    return json(res,200,{tickets: mine.slice().sort((a,b)=>b.updated-a.updated)});
  }
  if(m==='GET' && pathname==='/api/me/screenshots'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const mine = DB.screenshots.filter(s => s.author === u.nickname || s.authorId === u.id);
    return json(res,200,{shots: mine.slice().reverse().map(s => ({
      id:s.id, img:s.img, place:s.place, stock:s.stock, status:s.status,
      date:s.date, rejectReason:s.rejectReason||null
    }))});
  }
  if(m==='GET' && pathname==='/api/me/punishments'){
    const u = authRequired(req);
    if(!u) return json(res,401,{error:'Нет авторизации'});
    const mine = (DB.punishments||[]).filter(p =>
      p.userName === u.login || p.userName === u.nickname || p.userName === u.email
    );
    return json(res,200,{punishments: mine.slice().reverse()});
  }

  /* ---------- ROLES / USERS ---------- */
  if(m==='GET' && pathname==='/api/roles'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{roles: DB.roles});
  }
  if(m==='POST' && pathname==='/api/roles'){
    const u = authRequired(req); const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const {name, level, color} = await readBody(req);
    if(!name) return json(res,400,{error:'Название обязательно'});
    DB.roles.push({id:'custom_'+Date.now(), name, level:Number(level)||0, color:color||'#fff', perms:[]});
    saveDB();
    return json(res,200,{ok:true, roles: DB.roles});
  }
  if(m==='DELETE' && pathname.startsWith('/api/roles/')){
    const u = authRequired(req); const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const id = decodeURIComponent(pathname.slice('/api/roles/'.length));
    if(['owner','user','admin','agent'].includes(id)) return json(res,400,{error:'Системную роль удалить нельзя'});
    DB.roles = DB.roles.filter(r=>r.id!==id); saveDB();
    return json(res,200,{ok:true, roles: DB.roles});
  }
  if(m==='GET' && pathname==='/api/users'){
    const u = authRequired(req); const d = requirePerm(u,'manageUsers'); if(d) return json(res,d.code,{error:d.error});
    return json(res,200,{users: DB.users.map(publicUser)});
  }
  if(m==='POST' && pathname.match(/^\/api\/users\/[^/]+\/role$/)){
    const u = authRequired(req); const d = requirePerm(u,'manageUsers'); if(d) return json(res,d.code,{error:d.error});
    const target = findUser(pathname.split('/')[3]);
    if(!target) return json(res,404,{error:'Пользователь не найден'});
    const {role} = await readBody(req);
    const r = DB.roles.find(x=>x.id===role);
    if(!r) return json(res,400,{error:'Роль не существует'});
    target.role = r.id; target.roleName = r.name; saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/users\/[^/]+\/perm$/)){
    const u = authRequired(req); const d = requirePerm(u,'manageUsers'); if(d) return json(res,d.code,{error:d.error});
    const target = findUser(pathname.split('/')[3]);
    if(!target) return json(res,404,{error:'Не найден'});
    const {perm, value} = await readBody(req);
    if(!target.permOverrides) target.permOverrides = {};
    target.permOverrides[perm] = !!value; saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/users\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const id = pathname.split('/')[3];
    if(id===u.id) return json(res,400,{error:'Нельзя удалить себя'});
    const t = findUser(id);
    if(t && t.role==='owner') return json(res,400,{error:'Нельзя удалить владельца'});
    DB.users = DB.users.filter(x=>x.id!==id); saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- PUNISHMENTS ---------- */
  if(m==='GET' && pathname==='/api/punishments'){
    const u = authRequired(req); const d = requirePerm(u,'managePunishments'); if(d) return json(res,d.code,{error:d.error});
    deactivateExpiredPunishments();
    return json(res,200,{punishments: DB.punishments.slice().reverse()});
  }
  if(m==='POST' && pathname==='/api/punishments'){
    const u = authRequired(req); const d = requirePerm(u,'managePunishments'); if(d) return json(res,d.code,{error:d.error});
    const {type, userName, reason, duration, fromDate, toDate} = await readBody(req);
    if(!type || !userName || !reason) return json(res,400,{error:'Заполните все поля'});
    if(!PUNISH_TYPES[type]) return json(res,400,{error:'Неверный тип'});
    let from = fromDate ? Number(fromDate) : Date.now();
    let to;
    if(toDate) to = Number(toDate);
    else {
      const dur = parseDuration(duration);
      if(!dur) return json(res,400,{error:'Неверный срок (1h, 3d, 1w, 1M)'});
      to = from + dur;
    }
    if(to <= from) return json(res,400,{error:'Дата окончания должна быть позже'});
    const p = {
      id: DB.punishSeq++, type, userName,
      reason: String(reason).slice(0,500),
      fromDate: from, toDate: to,
      active: true, createdBy: u.nickname || u.login,
      createdAt: Date.now(), source: 'site'
    };
    DB.punishments.push(p); saveDB();
    audit.punishment(`✅ <b>Наказание выдано</b>\n\n` + fmtPunish(p) + `\n🖥 Источник: <b>сайт</b>`, p.type);
    return json(res,200,{ok:true, id:p.id, punishment:p});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/punishments\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'managePunishments'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[3]);
    const p = DB.punishments.find(x=>x.id===id);
    if(!p) return json(res,404,{error:'Наказание не найдено'});
    p.active = false;
    p.removedBy = u.nickname || u.login;
    p.removedAt = Date.now();
    saveDB();
    audit.punishment(`♻️ <b>Наказание снято</b>\n\n` + fmtPunish(p) + `\n👮 Снял: ${escapeHtml(u.nickname||u.login)}`, p.type);
    return json(res,200,{ok:true});
  }
  if(m==='GET' && pathname.match(/^\/api\/punishments\/check\/[^/]+$/)){
    const userName = decodeURIComponent(pathname.split('/')[4]);
    const now = Date.now();
    const active = (DB.punishments||[]).filter(p => p.active && p.toDate > now && p.userName === userName);
    return json(res,200,{active});
  }

  /* ---------- NEWS ---------- */
  if(m==='GET' && pathname==='/api/news'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{news: DB.news.slice().reverse()});
  }
  if(m==='POST' && pathname==='/api/news'){
    const u = authRequired(req); const d = requirePerm(u,'publishNews'); if(d) return json(res,d.code,{error:d.error});
    const {type,title,body,screenshot,id} = await readBody(req);
    if(!title || !body) return json(res,400,{error:'Заполните поля'});
    let item;
    if(id){
      const n = DB.news.find(x=>x.id==id);
      if(!n) return json(res,404,{error:'Не найдено'});
      n.type=type||'NEWS'; n.title=title; n.body=body; n.screenshot=screenshot||null; n.edited=new Date().toLocaleDateString('ru');
      item = n;
    } else {
      item = {id:Date.now(),type:type||'NEWS',title,body,screenshot:screenshot||null,author:u.nickname,date:new Date().toLocaleDateString('ru')};
      DB.news.push(item);
    }
    saveDB();
    const typeLbl = { NEWS:'📰 Новость', AD:'📣 Реклама', STORY:'📖 История', UPDATE:'🔄 Обновление' };
    audit.news(`${typeLbl[item.type]||'📰'}: <b>${escapeHtml(item.title)}</b>\n\n${escapeHtml((item.body||'').slice(0,400))}\n\n👤 ${escapeHtml(u.nickname)}`);
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/news\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'publishNews'); if(d) return json(res,d.code,{error:d.error});
    DB.news = DB.news.filter(n=>String(n.id)!==pathname.split('/')[3]); saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- SCREENSHOTS ---------- */
  if(m==='GET' && pathname==='/api/shots'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    const isMod = can(u,'moderateScreenshots');
    const list = DB.screenshots.filter(s=>s.status==='approved'||(isMod&&s.status==='pending')).map(s=>publicScreenshot(s,u.id));
    const approved = DB.screenshots.filter(s=>s.status==='approved').map(s=>publicScreenshot(s,u.id));
    return json(res,200,{shots:list, approved});
  }
  if(m==='POST' && pathname==='/api/shots'){
    const u = authRequired(req); const d = requirePerm(u,'submitScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const {img, place, stock} = await readBody(req);
    if(!img || !String(img).startsWith('data:image/')) return json(res,400,{error:'Нужно изображение'});
    if(String(img).length > 4*1024*1024) return json(res,413,{error:'Файл >3 МБ'});
    DB.screenshots.push({
      id:Date.now(), author:u.nickname, authorId:u.id, img, place:place||'', stock:stock||'',
      status:'pending', approvedAt:null, likes:[], dislikes:[], comments:[],
      date:new Date().toLocaleDateString('ru'), rejectReason:null
    });
    saveDB();
    audit.screenshot(`👤 ${escapeHtml(u.nickname)}\n📍 ${escapeHtml(place||'—')}\n🚂 ${escapeHtml(stock||'—')}\nСтатус: <b>на модерации</b>`);
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/shots\/[^/]+\/approve$/)){
    const u = authRequired(req); const d = requirePerm(u,'moderateScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[3]);
    const s = DB.screenshots.find(x=>x.id===id);
    if(!s) return json(res,404,{error:'Не найдено'});
    s.status = 'approved'; s.approvedAt = Date.now(); s.rejectReason = null;
    saveDB();
    audit.moderation(`✅ Скриншот одобрен\n👤 ${escapeHtml(s.author)}\n⚙️ ${escapeHtml(u.nickname)}`);
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/shots\/[^/]+\/reject$/)){
    const u = authRequired(req); const d = requirePerm(u,'moderateScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[3]);
    const s = DB.screenshots.find(x=>x.id===id);
    if(!s) return json(res,404,{error:'Не найдено'});
    const {reason} = await readBody(req);
    s.status = 'rejected';
    s.rejectReason = String(reason||'Без указания причины').slice(0,500);
    s.rejectedAt = Date.now();
    s.rejectedBy = u.nickname || u.login;
    saveDB();
    audit.moderation(`❌ Скриншот отклонён\n👤 ${escapeHtml(s.author)}\n⚙️ ${escapeHtml(u.nickname)}\n📝 ${escapeHtml(s.rejectReason)}`);
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/shots\/[^/]+\/(like|dislike)$/)){
    const u = authRequired(req); const d = requirePerm(u,'likeScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const s = DB.screenshots.find(x=>x.id===Number(pathname.split('/')[3]));
    if(!s) return json(res,404,{error:'Не найдено'});
    const isLike = pathname.endsWith('/like');
    const f = isLike?'likes':'dislikes'; const o = isLike?'dislikes':'likes';
    if(s[f].includes(u.id)) s[f] = s[f].filter(x=>x!==u.id);
    else { s[f].push(u.id); s[o] = s[o].filter(x=>x!==u.id); }
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/shots\/[^/]+\/comment$/)){
    const u = authRequired(req); const d = requirePerm(u,'commentScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const s = DB.screenshots.find(x=>x.id===Number(pathname.split('/')[3]));
    if(!s) return json(res,404,{error:'Не найдено'});
    const {text} = await readBody(req);
    if(!String(text||'').trim()) return json(res,400,{error:'Пусто'});
    s.comments.push({author:u.nickname, text:String(text).slice(0,1000), date:new Date().toLocaleString('ru')});
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/shots\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'moderateScreenshots'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[3]);
    DB.screenshots = DB.screenshots.filter(x=>x.id!==id);
    DB.weeklyTop = (DB.weeklyTop||[]).filter(w=>w.screenshotId!==id); saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- WEEKLY ---------- */
  if(m==='GET' && pathname==='/api/weekly'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{weeklyTop: DB.weeklyTop||[], lastPinnedWeek: DB.lastPinnedWeek||null});
  }
  if(m==='POST' && pathname==='/api/weekly/pin'){
    const u = authRequired(req); const d = requirePerm(u,'moderateScreenshots'); if(d) return json(res,d.code,{error:d.error});
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
    DB.lastPinnedWeek = weekKey; saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname==='/api/weekly'){
    const u = authRequired(req); const d = requirePerm(u,'moderateScreenshots'); if(d) return json(res,d.code,{error:d.error});
    DB.weeklyTop = []; DB.lastPinnedWeek = null; saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- BOARDS ---------- */
  if(m==='GET' && pathname==='/api/boards'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200, DB.boards);
  }
  if(m==='POST' && pathname.match(/^\/api\/boards\/(honor|shame)$/)){
    const u = authRequired(req); const d = requirePerm(u,'editBoard'); if(d) return json(res,d.code,{error:d.error});
    const k = pathname.split('/')[3];
    const {nick, desc} = await readBody(req);
    if(!nick||!desc) return json(res,400,{error:'Заполните поля'});
    DB.boards[k].push({id:Date.now(), nick, desc, date:new Date().toLocaleDateString('ru')}); saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/boards\/(honor|shame)\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'editBoard'); if(d) return json(res,d.code,{error:d.error});
    const [, , k, id] = pathname.split('/');
    DB.boards[k] = DB.boards[k].filter(e=>String(e.id)!==id); saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- GUIDES ---------- */
  if(m==='GET' && pathname==='/api/guides'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{guides: DB.guides});
  }
  if(m==='POST' && pathname==='/api/guides'){
    const u = authRequired(req); const d = requirePerm(u,'manageGuides'); if(d) return json(res,d.code,{error:d.error});
    const g = await readBody(req);
    if(!g.title) return json(res,400,{error:'Название обязательно'});
    if(g.id){
      const ex = DB.guides.find(x=>x.id==g.id);
      if(ex){ Object.assign(ex, g); saveDB(); return json(res,200,{ok:true}); }
    }
    g.id = Date.now(); g.author = u.nickname; g.date = new Date().toLocaleDateString('ru');
    DB.guides.push(g); saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/guides\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'manageGuides'); if(d) return json(res,d.code,{error:d.error});
    DB.guides = DB.guides.filter(x=>String(x.id)!==pathname.split('/')[3]); saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- MAPS ---------- */
  if(m==='GET' && pathname==='/api/maps'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{maps: DB.maps});
  }
  if(m==='POST' && pathname==='/api/maps'){
    const u = authRequired(req); const d = requirePerm(u,'managePacks'); if(d) return json(res,d.code,{error:d.error});
    const {name, desc, extLink, fileDataUrl, fileName, fileSize, fileType, cover, mapType} = await readBody(req);
    if(!name) return json(res,400,{error:'Название обязательно'});
    DB.maps.push({
      id:Date.now(), name, desc:desc||'',
      extLink:extLink||null, fileDataUrl:fileDataUrl||null, fileName:fileName||null,
      fileSize:fileSize||null, fileType:fileType||null,
      cover: cover || null, mapType: mapType || 'Реализм',
      author:u.nickname, date:new Date().toLocaleDateString('ru')
    });
    saveDB();
    audit.map(`👤 ${escapeHtml(u.nickname)}\n🗺 <b>${escapeHtml(name)}</b>\n🎨 ${escapeHtml(mapType||'Реализм')}\n${escapeHtml((desc||'').slice(0,200))}`);
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/maps\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'managePacks'); if(d) return json(res,d.code,{error:d.error});
    DB.maps = DB.maps.filter(m=>String(m.id)!==pathname.split('/')[3]); saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- PACKS ---------- */
  if(m==='GET' && pathname==='/api/packs'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{packs: DB.packs});
  }
  if(m==='POST' && pathname==='/api/packs'){
    const u = authRequired(req); const d = requirePerm(u,'managePacks'); if(d) return json(res,d.code,{error:d.error});
    const p = await readBody(req);
    if(!p.name) return json(res,400,{error:'Название обязательно'});
    delete p.roles;
    p.id = Date.now(); p.author = u.nickname; p.date = new Date().toLocaleDateString('ru');
    if(!p.packType) p.packType = 'Реализм';
    DB.packs.push(p); saveDB();
    audit.pack(`👤 ${escapeHtml(u.nickname)}\n📦 <b>${escapeHtml(p.name)}</b>\n🎨 ${escapeHtml(p.packType)}\n${escapeHtml((p.desc||'').slice(0,200))}`);
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/packs\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'managePacks'); if(d) return json(res,d.code,{error:d.error});
    DB.packs = DB.packs.filter(p=>String(p.id)!==pathname.split('/')[3]); saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- STAFF ---------- */
  if(m==='GET' && pathname==='/api/staff'){
    const u = authRequired(req); const d = requirePerm(u,'staffChat'); if(d) return json(res,d.code,{error:d.error});
    return json(res,200,{messages: DB.staffMessages.slice(-300)});
  }
  if(m==='POST' && pathname==='/api/staff'){
    const u = authRequired(req); const d = requirePerm(u,'staffChat'); if(d) return json(res,d.code,{error:d.error});
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
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    const isMod = can(u,'supportReply');
    const kind = q.kind;
    let list = DB.tickets;
    if(kind) list = list.filter(t=>t.kind===kind);
    if(!isMod) list = list.filter(t=>t.userId===u.id);
    return json(res,200,{tickets: list.slice().sort((a,b)=>b.updated-a.updated)});
  }
  if(m==='POST' && pathname==='/api/tickets'){
    const u = authRequired(req); const d = requirePerm(u,'supportChat'); if(d) return json(res,d.code,{error:d.error});
    const {kind, subject, category, description, files} = await readBody(req);
    if(!subject || !description) return json(res,400,{error:'Заполните поля'});
    const t = {
      id: DB.ticketSeq++, kind: kind==='mapdev'?'mapdev':'support',
      userId:u.id, userName:u.nickname,
      subject, category:category||'Другое', description,
      files: Array.isArray(files)?files.slice(0,6):[],
      status:'Новая', created:Date.now(), updated:Date.now(),
      messages:[], agentId:null, agentName:null, rejectReason:null
    };
    DB.tickets.push(t); saveDB();
    audit.support(`🎫 <b>Тикет #${t.id}</b>\n👤 ${escapeHtml(u.nickname)}\nКатегория: ${escapeHtml(t.category)}\n📝 <b>${escapeHtml(subject)}</b>\n\n${escapeHtml(description.slice(0,500))}`);
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
    t.messages.push({userId:u.id, author:u.nickname, text:tx, date:Date.now(), attach:Array.isArray(attach)?attach.slice(0,6):[]});
    t.updated = Date.now();
    if(can(u,'supportReply') && !t.agentName){ t.agentId = u.id; t.agentName = u.nickname; }
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/tickets\/[^/]+\/status$/)){
    const u = authRequired(req); const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const t = DB.tickets.find(x=>x.id===Number(pathname.split('/')[3]));
    if(!t) return json(res,404,{error:'Не найден'});
    const {status, reason} = await readBody(req);
    const ok = ['Новая','В работе','Решена','Отклонена'];
    if(!ok.includes(status)) return json(res,400,{error:'Неверный статус'});
    t.status = status; t.updated = Date.now();
    if(status === 'Отклонена') t.rejectReason = String(reason||'Без указания причины').slice(0,500);
    if(!t.agentName){ t.agentId = u.id; t.agentName = u.nickname; }
    t.messages.push({userId:u.id, author:'Система', text:'Статус: «'+status+'»'+(reason?' — '+reason:''), date:Date.now(), attach:[]});
    saveDB();
    audit.ticket(`⚙️ Статус тикета <b>#${t.id}</b> → <b>${escapeHtml(status)}</b>${reason?'\n📝 '+escapeHtml(reason):''}\n👤 ${escapeHtml(u.nickname)}`);
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/tickets\/[^/]+$/)){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    const id = Number(pathname.split('/')[3]);
    const idx = DB.tickets.findIndex(x=>x.id===id);
    if(idx < 0) return json(res,404,{error:'Тикет не найден'});
    const t = DB.tickets[idx];
    const isAuthor = t.userId === u.id;
    const isMod = can(u, 'supportReply');
    if(!isAuthor && !isMod) return json(res,403,{error:'Нет доступа'});
    if(isAuthor && !isMod){
      if(!['Решена','Отклонена'].includes(t.status)) return json(res,403,{error:'Можно удалить только закрытые'});
    }
    DB.tickets.splice(idx, 1); saveDB();
    return json(res,200,{ok:true});
  }

  /* ---------- FORUM ---------- */
  if(m==='GET' && pathname==='/api/forum/sections'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    return json(res,200,{sections: DB.forum.sections});
  }
  if(m==='POST' && pathname==='/api/forum/sections'){
    const u = authRequired(req); const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const {icon, name, desc} = await readBody(req);
    if(!name) return json(res,400,{error:'Название обязательно'});
    DB.forum.sections.push({id:Date.now(), icon:icon||'💬', name, desc:desc||''}); saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/forum\/sections\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const id = Number(pathname.split('/')[4]);
    DB.forum.sections = DB.forum.sections.filter(s=>s.id!==id);
    DB.forum.topics = DB.forum.topics.filter(t=>t.sectionId!==id); saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='GET' && pathname==='/api/forum/topics'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    const sid = Number(q.sectionId);
    let list = DB.forum.topics;
    if(sid) list = list.filter(t=>t.sectionId===sid);
    return json(res,200,{topics: list});
  }
  if(m==='POST' && pathname==='/api/forum/topics'){
    const u = authRequired(req);
    const {sectionId, title, body} = await readBody(req);
    if(!sectionId || !title || !body) return json(res,400,{error:'Заполните поля'});
    DB.forum.topics.push({id:Date.now(), sectionId:Number(sectionId), title, pinned:false, locked:false, views:0, author:u.nickname, authorId:u.id, created:Date.now(), lastActivity:Date.now(), posts:[{id:Date.now()+1, author:u.nickname, authorId:u.id, avatar:u.avatar||null, text:String(body).slice(0,20000), date:new Date().toLocaleString('ru')}]});
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/forum\/topics\/[^/]+\/reply$/)){
    const u = authRequired(req);
    const t = DB.forum.topics.find(x=>x.id===Number(pathname.split('/')[4]));
    if(!t) return json(res,404,{error:'Тема не найдена'});
    if(t.locked) return json(res,403,{error:'Тема закрыта'});
    const {text} = await readBody(req);
    if(!String(text||'').trim()) return json(res,400,{error:'Пусто'});
    t.posts.push({id:Date.now(), author:u.nickname, authorId:u.id, avatar:u.avatar||null, text:String(text).slice(0,20000), date:new Date().toLocaleString('ru')});
    t.lastActivity = Date.now(); saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/forum\/topics\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    DB.forum.topics = DB.forum.topics.filter(t=>t.id!==Number(pathname.split('/')[4])); saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/forum\/topics\/[^/]+\/(pin|lock)$/)){
    const u = authRequired(req); const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    const t = DB.forum.topics.find(x=>x.id===Number(pathname.split('/')[4]));
    if(!t) return json(res,404,{error:'Не найдена'});
    if(pathname.endsWith('/pin')) t.pinned = !t.pinned; else t.locked = !t.locked;
    saveDB();
    return json(res,200,{ok:true, topic:t});
  }

  /* ---------- RECRUITMENT ---------- */
  if(m==='GET' && pathname==='/api/recruit'){
    const u = authRequired(req); if(!u) return json(res,401,{error:'Нет авторизации'});
    const isMod = can(u,'supportReply');
    return json(res,200,{
      enabled: DB.recruitment.enabled,
      forms: DB.recruitment.forms,
      applications: isMod ? DB.recruitment.applications : DB.recruitment.applications.filter(a=>a.userId===u.id),
      interviewInfo: DB.recruitment.interviewInfo,
      interviewChannel: DB.recruitment.interviewChannel
    });
  }
  if(m==='POST' && pathname==='/api/recruit/toggle'){
    const u = authRequired(req); const d = requirePerm(u,'manageRoles'); if(d) return json(res,d.code,{error:d.error});
    DB.recruitment.enabled = !DB.recruitment.enabled; saveDB();
    return json(res,200,{ok:true, enabled: DB.recruitment.enabled});
  }
  if(m==='POST' && pathname==='/api/recruit/forms'){
    const u = authRequired(req); const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const f = await readBody(req);
    if(!f.name) return json(res,400,{error:'Название обязательно'});
    if(f.id){
      const ex = DB.recruitment.forms.find(x=>x.id==f.id);
      if(ex){ Object.assign(ex, f); saveDB(); return json(res,200,{ok:true}); }
    }
    f.id = Date.now(); f.open = true; f.author = u.nickname; f.date = new Date().toLocaleDateString('ru');
    DB.recruitment.forms.push(f); saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/recruit\/forms\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const id = pathname.split('/')[4];
    DB.recruitment.forms = DB.recruitment.forms.filter(f=>String(f.id)!==id);
    DB.recruitment.applications = DB.recruitment.applications.filter(a=>String(a.formId)!==id); saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/recruit\/forms\/[^/]+\/toggle$/)){
    const u = authRequired(req); const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const f = DB.recruitment.forms.find(x=>x.id===Number(pathname.split('/')[4]));
    if(!f) return json(res,404,{error:'Не найдена'});
    f.open = !f.open; saveDB();
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
    DB.recruitment.applications.push({id:Date.now(), formId, userId:u.id, userName:u.nickname, answers: answers||[], status:'На рассмотрении', date:Date.now()});
    saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='POST' && pathname.match(/^\/api\/recruit\/applications\/[^/]+\/status$/)){
    const u = authRequired(req); const d = requirePerm(u,'supportReply'); if(d) return json(res,d.code,{error:d.error});
    const a = DB.recruitment.applications.find(x=>x.id===Number(pathname.split('/')[4]));
    if(!a) return json(res,404,{error:'Не найдена'});
    const {status} = await readBody(req);
    a.status = status; saveDB();
    return json(res,200,{ok:true});
  }
  if(m==='DELETE' && pathname.match(/^\/api\/recruit\/applications\/[^/]+$/)){
    const u = authRequired(req); const d = requirePerm(u,'manageUsers'); if(d) return json(res,d.code,{error:d.error});
    DB.recruitment.applications = DB.recruitment.applications.filter(a=>a.id!==Number(pathname.split('/')[4])); saveDB();
    return json(res,200,{ok:true});
  }

  return json(res,404,{error:'Не найдено'});
}

/* ============================================================
   HTTP SERVER
   ============================================================ */
const server = http.createServer(async (req,res) => {
  try{
    const url = new URL(req.url, BASE_URL);
    const pathname = url.pathname;
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
    if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }
    if(pathname==='/' || pathname==='/index.html'){
      if(!fs.existsSync(HTML_FILE)){ res.writeHead(500); return res.end('index.html не найден'); }
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(fs.readFileSync(HTML_FILE,'utf8'));
    }
    if(pathname.startsWith('/api/')) return handleApi(req,res,pathname);
    res.writeHead(404); res.end('Not found');
  }catch(e){
    console.error('❌', e.message);
    try{ json(res,500,{error:'Внутренняя ошибка'}); }catch{}
  }
});

server.on('error', (e) => console.error('❌ Server error:', e.message));

server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        MFMIR V2 сервер запущен 🛡           ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  URL:     ' + BASE_URL.padEnd(34) + '║');
  console.log('║  Порт:    ' + String(PORT).padEnd(34) + '║');
  console.log('║  Gmail:   ' + ((process.env.GMAIL_REFRESH_TOKEN?'✅':'⚠ нет')).padEnd(34) + '║');
  console.log('║  TG бот:  ' + ((TG_BOT_TOKEN?'✅':'⚠ нет')).padEnd(34) + '║');
  console.log('║  TG группа: ' + ((TG_GROUP_ID?'✅':'⚠ нет')).padEnd(32) + '║');
  console.log('╚══════════════════════════════════════════════╝\n');

  try{ deactivateExpiredPunishments(); }catch(e){}
  try{ await setupTopics(); }catch(e){ console.error('setupTopics:', e.message); }
  tgPollLoop();

  try{
    await audit.server(
      `🚀 <b>Сервер MFMIR V2 запущен</b>\n` +
      `🕒 ${new Date().toLocaleString('ru-RU')}\n` +
      `🔧 Порт: <code>${PORT}</code>\n` +
      `🌐 URL: <code>${BASE_URL}</code>\n\n` +
      `<b>Команды в группе:</b>\n` +
      `<code>/бан @user 7d причина</code>\n` +
      `<code>/мут @user 1h причина</code>\n` +
      `<code>/кик @user причина</code>\n` +
      `<code>/варн @user 3d причина</code>\n` +
      `<code>/снять @user</code>`
    );
  }catch(e){ console.error('audit.server:', e.message); }
});
