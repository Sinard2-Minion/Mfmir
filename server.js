#!/usr/bin/env node
// ============================================================
// MFMIR — сервер. Все секреты только из переменных окружения.
// Node.js 18+. Без внешних зависимостей.
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

/* ============ ЧТЕНИЕ СЕКРЕТОВ ИЗ ХОСТИНГА ============ */
const PORT       = Number(process.env.PORT || 3000);
const BASE_URL   = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || '';

if(!JWT_SECRET || JWT_SECRET.length < 32){
  console.error('\n❌ JWT_SECRET не задан или слишком короткий.');
  console.error('   Задай в хостинге: JWT_SECRET=<случайная_строка_64_символа>');
  console.error('   Сгенерировать: openssl rand -hex 32\n');
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
  chatId: process.env.TG_CHAT_ID   || '',
  enabled: !!(process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID)
};

/* ============ ПРОВЕРКА ПЕРЕД СТАРТОМ ============ */
console.log('\n🔍 Проверка окружения:');
console.log('   JWT_SECRET:    ' + (JWT_SECRET ? '✅' : '❌'));
console.log('   OWNER_EMAIL:   ' + (process.env.OWNER_EMAIL ? '✅' : '⚠ не задан (по умолчанию owner@mfmr.ru)'));
console.log('   OWNER_PASSWORD:' + (process.env.OWNER_PASSWORD ? '✅' : '⚠ не задан (будет дефолтный — НЕ безопасно!)'));
console.log('   SMTP:          ' + (SMTP.host && SMTP.user && SMTP.pass ? '✅ ' + SMTP.host : '⚠ не задан (письма → консоль)'));
console.log('   Telegram:      ' + (TG.enabled ? '✅' : '⚠ не задан (аудит выключен)'));

/* ============ TELEGRAM АУДИТ ============ */
async function tgAudit(event, details = {}){
  if(!TG.enabled) return;
  try {
    const esc = s => String(s).replace(/([_*\[\]`])/g, '\\$1').slice(0, 300);
    const text =
      `🔔 *${esc(event)}*\n` +
      Object.entries(details).map(([k,v]) => `• ${esc(k)}: \`${esc(v)}\``).join('\n') +
      `\n🕒 ${new Date().toLocaleString('ru-RU')}`;

    await fetch(`https://api.telegram.org/bot${TG.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
  } catch(e){
    console.error('⚠ TG audit:', e.message);
  }
}

/* ============ ХРАНИЛИЩЕ ============ */
let DB = loadDB();

function loadDB(){
  try {
    if(fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e){ console.error('⚠ Чтение БД:', e.message); }
  return seedDB();
}
function saveDB(){
  try{ fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 2)); }
  catch(e){ console.error('⚠ Запись БД:', e.message); }
}
function seedDB(){
  const owner = {
    id: crypto.randomUUID(),
    email: (process.env.OWNER_EMAIL || 'owner@mfmr.ru').toLowerCase(),
    login: process.env.OWNER_LOGIN || 'owner',
    nickname: process.env.OWNER_NICKNAME || 'MFMIR_Owner',
    passwordHash: hashPassword(process.env.OWNER_PASSWORD || crypto.randomBytes(16).toString('hex')),
    role: 'Владелец',
    emailVerified: true,
    isTemporary: false,
    createdAt: Date.now()
  };
  const db = {
    users: [owner],
    tokens: [],
    roles: [
      { name: 'Пользователь',    perms: ['view_news','comment','like','upload_shot'] },
      { name: 'Агент Поддержки', perms: ['view_news','comment','like','upload_shot','answer_support','staff_chat'] },
      { name: 'Админ',           perms: ['view_news','comment','like','upload_shot','moderate_shots','edit_news','edit_boards','upload_maps','upload_guides','staff_chat'] },
      { name: 'Владелец',        perms: ['view_news','comment','like','upload_shot','moderate_shots','edit_news','edit_boards','answer_support','manage_roles','upload_maps','upload_guides','staff_chat','manage_all'] }
    ],
    shots: [], boards: { honor: [], shame: [] }, news: [],
    guides: [{
      id: crypto.randomUUID(),
      title: 'Провисание Контактной сети',
      text: 'Гайд будет добавлен позже.',
      author: owner.nickname, date: Date.now()
    }],
    maps: [], staffChat: [], tickets: { buy: [], support: [] }
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  console.log('👑 Создан владелец:', owner.login);
  tgAudit('👑 Сервер запущен — создан владелец', { login: owner.login });
  return db;
}

/* ============ КРИПТО ============ */
function hashPassword(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored){
  try{
    const [alg, salt, hash] = String(stored).split('$');
    if(alg !== 'scrypt') return false;
    const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash,'hex'), Buffer.from(test,'hex'));
  } catch { return false; }
}
function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function b64urlDecode(s){
  s = String(s).replace(/-/g,'+').replace(/_/g,'/');
  while(s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}
function signJWT(payload){
  const header = b64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const now = Math.floor(Date.now()/1000);
  const body = b64url(JSON.stringify({ ...payload, iat:now, exp:now+7*24*3600 }));
  const data = header + '.' + body;
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(data).digest());
  return data + '.' + sig;
}
function verifyJWT(token){
  try{
    const [h, p, s] = String(token).split('.');
    if(!h || !p || !s) return null;
    const expected = b64url(crypto.createHmac('sha256', JWT_SECRET).update(h+'.'+p).digest());
    if(s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
    const payload = JSON.parse(b64urlDecode(p));
    if(payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

/* ============ SMTP (порт 465, SSL) ============ */
function emailOf(from){ const m = String(from).match(/<([^>]+)>/); return m ? m[1] : String(from).trim(); }
function wrap76(s){ const o = []; for(let i=0;i<s.length;i+=76) o.push(s.slice(i,i+76)); return o.join('\r\n'); }
function buildMime({ from, to, subject, text, html }){
  const boundary = '----mfmr' + crypto.randomBytes(8).toString('hex');
  const msgId = `<${crypto.randomBytes(16).toString('hex')}@mfmr>`;
  const date = new Date().toUTCString();
  const subjEnc = '=?UTF-8?B?' + Buffer.from(subject || '', 'utf8').toString('base64') + '?=';
  const L = [];
  L.push(`From: ${from}`);
  L.push(`To: ${to}`);
  L.push(`Subject: ${subjEnc}`);
  L.push(`Date: ${date}`);
  L.push(`Message-ID: ${msgId}`);
  L.push(`MIME-Version: 1.0`);
  if(html && text){
    L.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    L.push('', '--' + boundary);
    L.push('Content-Type: text/plain; charset=UTF-8');
    L.push('Content-Transfer-Encoding: base64', '');
    L.push(wrap76(Buffer.from(text, 'utf8').toString('base64')));
    L.push('--' + boundary);
    L.push('Content-Type: text/html; charset=UTF-8');
    L.push('Content-Transfer-Encoding: base64', '');
    L.push(wrap76(Buffer.from(html, 'utf8').toString('base64')));
    L.push('--' + boundary + '--');
  } else if(html){
    L.push('Content-Type: text/html; charset=UTF-8');
    L.push('Content-Transfer-Encoding: base64', '');
    L.push(wrap76(Buffer.from(html, 'utf8').toString('base64')));
  } else {
    L.push('Content-Type: text/plain; charset=UTF-8');
    L.push('Content-Transfer-Encoding: base64', '');
    L.push(wrap76(Buffer.from(text || '', 'utf8').toString('base64')));
  }
  return L.map(l => l.startsWith('.') ? '.' + l : l).join('\r\n');
}
function smtpSend({ to, subject, text, html }){
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host }, () => run().catch(reject));
    let buf = '';
    const waiting = [];
    const timeout = setTimeout(() => { try{socket.destroy();}catch{} reject(new Error('SMTP timeout')); }, 30000);

    function parse(){
      let i;
      while((i = buf.indexOf('\r\n')) !== -1){
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if(waiting.length) waiting.shift()(line);
      }
    }
    function read(){ return new Promise(res => { waiting.push(res); parse(); }); }
    function write(s){ socket.write(s + '\r\n'); }
    socket.on('data', c => { buf += c.toString('utf8'); parse(); });
    socket.on('error', e => { clearTimeout(timeout); reject(e); });

    async function readMultiline(){
      while(true){
        const l = await read();
        if(/^\d{3} /.test(l)) return;
        if(!/^\d{3}-/.test(l)) throw new Error('SMTP: ' + l);
      }
    }
    async function expect(p){
      const l = await read();
      if(!l.startsWith(p)) throw new Error('SMTP expected ' + p + ' got: ' + l);
    }
    async function run(){
      try{
        await expect('220');
        write('EHLO mfmr.local');
        await readMultiline();
        write('AUTH LOGIN');
        await expect('334');
        write(Buffer.from(SMTP.user).toString('base64'));
        await expect('334');
        write(Buffer.from(SMTP.pass).toString('base64'));
        const auth = await read();
        if(!auth.startsWith('235')) throw new Error('AUTH: ' + auth);
        write(`MAIL FROM:<${emailOf(SMTP.from)}>`);
        await expect('250');
        write(`RCPT TO:<${to}>`);
        await expect('250');
        write('DATA');
        await expect('354');
        socket.write(buildMime({ from: SMTP.from, to, subject, text, html }) + '\r\n.\r\n');
        const d = await read();
        if(!d.startsWith('250')) throw new Error('DATA: ' + d);
        write('QUIT');
        socket.end();
        clearTimeout(timeout);
        resolve({ ok:true });
      } catch(e){ clearTimeout(timeout); try{socket.destroy();}catch{} reject(e); }
    }
  });
}
async function sendMail({ to, subject, text, html }){
  if(!SMTP.host || !SMTP.user || !SMTP.pass){
    console.log('\n📧 DEV MAIL →', to);
    console.log('   Subject:', subject);
    console.log('   Text:', (text || String(html||'').replace(/<[^>]+>/g,' ')).slice(0,150));
    return { dev:true };
  }
  try {
    await smtpSend({ to, subject, text, html });
    console.log('📧 Отправлено →', to);
  } catch(e){
    console.error('❌ SMTP:', e.message);
    throw e;
  }
}

/* ============ HTTP HELPERS ============ */
function json(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if(data.length > 20*1024*1024){ reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { if(!data) return resolve({}); try{ resolve(JSON.parse(data)); } catch(e){ reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function findUser(q){ return typeof q === 'function' ? DB.users.find(q) : DB.users.find(u => u.id === q || u.email === q || u.login === q); }
function findByEmail(email){ return DB.users.find(u => u.email === String(email||'').toLowerCase()); }
function findByLogin(login){ return DB.users.find(u => u.login === login); }
function permsOf(u){ if(!u) return []; const r = DB.roles.find(x => x.name === u.role); return r ? r.perms : []; }
function can(u, perm){ const p = permsOf(u); return p.includes(perm) || p.includes('manage_all'); }
function authRequired(req){
  const h = req.headers.authorization || '';
  if(!h.startsWith('Bearer ')) return null;
  const data = verifyJWT(h.slice(7));
  return data ? findUser(data.id) : null;
}
function requirePerm(u, perm){
  if(!u) return { error:'Нет авторизации', code:401 };
  if(!can(u, perm)) return { error:'Недостаточно прав', code:403 };
  return null;
}

/* ============ API ============ */
async function handleApi(req, res, pathname){
  const m = req.method;

  if(m === 'POST' && pathname === '/api/auth/register'){
    const { email, login, password } = await readBody(req);
    if(!email || !login || !password) return json(res, 400, { error:'Все поля обязательны' });
    if(String(password).length < 6) return json(res, 400, { error:'Пароль минимум 6 символов' });
    if(findByEmail(email)) return json(res, 409, { error:'Email занят' });
    if(findByLogin(login))  return json(res, 409, { error:'Логин занят' });

    const code = String(Math.floor(100000 + Math.random()*900000));
    DB.tokens = DB.tokens.filter(t => t.expiresAt > Date.now());
    DB.tokens.push({
      id: crypto.randomUUID(), type:'verify_email', code,
      email: email.toLowerCase(), login, passwordHash: hashPassword(password),
      expiresAt: Date.now() + 30*60*1000, used:false
    });
    saveDB();

    let devCode;
    try{
      await sendMail({
        to: email,
        subject: 'Код подтверждения — MFMIR',
        text: `Ваш код: ${code}`,
        html: `<div style="font-family:Arial;background:#000;color:#fff;padding:30px;border-radius:12px;max-width:480px">
          <h1 style="letter-spacing:4px;margin:0 0 8px">MFMIR</h1>
          <p style="color:#aaa">Код подтверждения:</p>
          <div style="font-size:38px;font-weight:900;letter-spacing:8px;padding:14px;background:#111;text-align:center;border-radius:8px">${code}</div>
          <p style="color:#888;font-size:13px;margin-top:16px">Код действует 30 минут.</p>
        </div>`
      });
    } catch(e){ devCode = code; }
    if(!SMTP.host) devCode = code;
    tgAudit('🆕 Регистрация', { email, login });
    return json(res, 200, { ok:true, message:'Код отправлен на ' + email, devCode });
  }

  if(m === 'POST' && pathname === '/api/auth/confirm'){
    const { email, code } = await readBody(req);
    const tok = DB.tokens.find(t => t.type==='verify_email' && !t.used &&
      t.email===String(email||'').toLowerCase() && t.code===String(code||''));
    if(!tok || tok.expiresAt < Date.now()) return json(res, 400, { error:'Неверный или просроченный код' });
    const user = {
      id: crypto.randomUUID(), email: tok.email, login: tok.login, nickname: tok.login,
      passwordHash: tok.passwordHash, role:'Пользователь',
      emailVerified: true, isTemporary: true, createdAt: Date.now()
    };
    DB.users.push(user); tok.used = true; saveDB();
    tgAudit('✅ Пользователь подтверждён', { email: user.email, login: user.login });
    return json(res, 200, {
      ok:true, token: signJWT({ id:user.id, role:user.role, nickname:user.nickname }),
      user:{ id:user.id, email:user.email, login:user.login, nickname:user.nickname, role:user.role, isTemporary:true }
    });
  }

  if(m === 'POST' && pathname === '/api/auth/login'){
    const { identifier, password } = await readBody(req);
    const u = findByEmail(identifier) || findByLogin(identifier);
    if(!u || !verifyPassword(password, u.passwordHash)) {
      tgAudit('❌ Неудачный вход', { identifier, ip: req.socket.remoteAddress });
      return json(res, 401, { error:'Неверные данные' });
    }
    tgAudit('🔑 Вход', { login: u.login, role: u.role, ip: req.socket.remoteAddress });
    return json(res, 200, {
      token: signJWT({ id:u.id, role:u.role, nickname:u.nickname }),
      user:{ id:u.id, email:u.email, login:u.login, nickname:u.nickname, role:u.role, isTemporary:!!u.isTemporary }
    });
  }

  if(m === 'POST' && pathname === '/api/auth/setup-profile'){
    const user = authRequired(req);
    if(!user) return json(res, 401, { error:'Нет авторизации' });
    const { nickname } = await readBody(req);
    if(!nickname || !String(nickname).trim()) return json(res, 400, { error:'Ник обязателен' });
    user.nickname = String(nickname).trim();
    user.isTemporary = false;
    saveDB();
    tgAudit('👤 Ник установлен', { login: user.login, nickname: user.nickname });
    return json(res, 200, { ok:true, nickname:user.nickname });
  }

  if(m === 'GET' && pathname === '/api/auth/me'){
    const u = authRequired(req);
    if(!u) return json(res, 401, { error:'Нет авторизации' });
    return json(res, 200, { id:u.id, email:u.email, login:u.login, nickname:u.nickname,
      role:u.role, isTemporary:!!u.isTemporary, perms: permsOf(u) });
  }

  if(m === 'GET' && pathname === '/api/roles'){
    const u = authRequired(req);
    if(!u) return json(res, 401, { error:'Нет авторизации' });
    return json(res, 200, { roles: DB.roles, permsList: [
      'view_news','comment','like','upload_shot','moderate_shots','edit_news',
      'edit_boards','answer_support','manage_roles','upload_maps','upload_guides',
      'staff_chat','manage_all'
    ]});
  }

  if(m === 'POST' && pathname === '/api/roles'){
    const u = authRequired(req);
    const d = requirePerm(u, 'manage_roles'); if(d) return json(res, d.code, { error:d.error });
    const { name, perms } = await readBody(req);
    if(!name || !Array.isArray(perms)) return json(res, 400, { error:'name и perms обязательны' });
    const ex = DB.roles.find(r => r.name === name);
    if(ex) ex.perms = perms; else DB.roles.push({ name, perms });
    saveDB();
    tgAudit('🎭 Роль сохранена', { name, by: u.nickname });
    return json(res, 200, { ok:true, roles: DB.roles });
  }

  if(m === 'DELETE' && pathname.startsWith('/api/roles/')){
    const u = authRequired(req);
    const d = requirePerm(u, 'manage_roles'); if(d) return json(res, d.code, { error:d.error });
    const name = decodeURIComponent(pathname.slice('/api/roles/'.length));
    if(name === 'Владелец' || name === 'Пользователь') return json(res, 400, { error:'Эту роль удалить нельзя' });
    DB.roles = DB.roles.filter(r => r.name !== name);
    saveDB();
    tgAudit('🗑 Роль удалена', { name, by: u.nickname });
    return json(res, 200, { ok:true, roles: DB.roles });
  }

  if(m === 'GET' && pathname === '/api/users'){
    const u = authRequired(req);
    const d = requirePerm(u, 'manage_roles'); if(d) return json(res, d.code, { error:d.error });
    return json(res, 200, { users: DB.users.map(x => ({ id:x.id, email:x.email, login:x.login, nickname:x.nickname, role:x.role })) });
  }

  if(m === 'POST' && pathname.match(/^\/api\/users\/[^/]+\/role$/)){
    const u = authRequired(req);
    const d = requirePerm(u, 'manage_roles'); if(d) return json(res, d.code, { error:d.error });
    const target = findUser(pathname.split('/')[3]);
    if(!target) return json(res, 404, { error:'Пользователь не найден' });
    const { role } = await readBody(req);
    if(!DB.roles.find(r => r.name === role)) return json(res, 400, { error:'Роль не существует' });
    target.role = role; saveDB();
    tgAudit('🎭 Смена роли', { кому: target.login, новая_роль: role, кто: u.nickname });
    return json(res, 200, { ok:true });
  }

  if(m === 'GET' && pathname === '/api/shots'){
    const u = authRequired(req);
    if(!u) return json(res, 401, { error:'Нет авторизации' });
    const shots = DB.shots.map(s => ({
      id:s.id, data:s.data, author:s.author, place:s.place, rolling:s.rolling,
      date:s.date, approved:s.approved,
      likes:s.likes.length, dislikes:s.dislikes.length, comments:s.comments,
      likedByMe: s.likes.includes(u.id), dislikedByMe: s.dislikes.includes(u.id)
    }));
    const pending = can(u, 'moderate_shots') ? DB.shots.filter(s => !s.approved) : [];
    return json(res, 200, { shots, pending });
  }

  if(m === 'POST' && pathname === '/api/shots'){
    const u = authRequired(req);
    const d = requirePerm(u, 'upload_shot'); if(d) return json(res, d.code, { error:d.error });
    const { data, place, rolling } = await readBody(req);
    if(!data || !String(data).startsWith('data:image/')) return json(res, 400, { error:'Нужно изображение' });
    if(String(data).length > 8*1024*1024) return json(res, 413, { error:'Файл слишком большой' });
    DB.shots.push({
      id: crypto.randomUUID(), data, place: place||'', rolling: rolling||'',
      author: u.nickname, authorId: u.id, date: Date.now(),
      approved: false, likes: [], dislikes: [], comments: []
    });
    saveDB();
    tgAudit('📸 Скриншот на модерацию', { автор: u.nickname, место: place, состав: rolling });
    return json(res, 200, { ok:true });
  }

  if(m === 'POST' && pathname.match(/^\/api\/shots\/[^/]+\/approve$/)){
    const u = authRequired(req);
    const d = requirePerm(u, 'moderate_shots'); if(d) return json(res, d.code, { error:d.error });
    const id = pathname.split('/')[3];
    const s = DB.shots.find(x => x.id === id);
    if(!s) return json(res, 404, { error:'Не найдено' });
    const { approve } = await readBody(req);
    if(approve === false) DB.shots = DB.shots.filter(x => x.id !== id);
    else s.approved = true;
    saveDB();
    tgAudit(approve === false ? '❌ Скриншот отклонён' : '✅ Скриншот одобрен', { модератор: u.nickname });
    return json(res, 200, { ok:true });
  }

  if(m === 'POST' && pathname.match(/^\/api\/shots\/[^/]+\/like$/)){
    const u = authRequired(req);
    const d = requirePerm(u, 'like'); if(d) return json(res, d.code, { error:d.error });
    const s = DB.shots.find(x => x.id === pathname.split('/')[3]);
    if(!s) return json(res, 404, { error:'Не найдено' });
    const { kind } = await readBody(req);
    const f = kind === 'dis' ? 'dislikes' : 'likes';
    const o = f === 'likes' ? 'dislikes' : 'likes';
    if(s[f].includes(u.id)) s[f] = s[f].filter(x => x !== u.id);
    else { s[f].push(u.id); s[o] = s[o].filter(x => x !== u.id); }
    saveDB();
    return json(res, 200, { ok:true, likes:s.likes.length, dislikes:s.dislikes.length });
  }

  if(m === 'POST' && pathname.match(/^\/api\/shots\/[^/]+\/comment$/)){
    const u = authRequired(req);
    const d = requirePerm(u, 'comment'); if(d) return json(res, d.code, { error:d.error });
    const s = DB.shots.find(x => x.id === pathname.split('/')[3]);
    if(!s) return json(res, 404, { error:'Не найдено' });
    const { text } = await readBody(req);
    const t = String(text || '').trim();
    if(!t) return json(res, 400, { error:'Пусто' });
    s.comments.push({ author: u.nickname, text: t, date: Date.now() });
    saveDB();
    return json(res, 200, { ok:true, comments: s.comments });
  }

  if(m === 'GET' && pathname === '/api/boards'){
    const u = authRequired(req);
    if(!u) return json(res, 401, { error:'Нет авторизации' });
    return json(res, 200, DB.boards);
  }
  if(m === 'POST' && pathname.match(/^\/api\/boards\/(honor|shame)$/)){
    const u = authRequired(req);
    const d = requirePerm(u, 'edit_boards'); if(d) return json(res, d.code, { error:d.error });
    const k = pathname.split('/')[3];
    const { nick, desc } = await readBody(req);
    if(!nick || !desc) return json(res, 400, { error:'nick и desc обязательны' });
    DB.boards[k].push({ nick, desc }); saveDB();
    return json(res, 200, { ok:true, boards: DB.boards });
  }

  if(m === 'GET' && pathname === '/api/news'){
    const u = authRequired(req);
    if(!u) return json(res, 401, { error:'Нет авторизации' });
    return json(res, 200, { news: DB.news.slice().reverse() });
  }
  if(m === 'POST' && pathname === '/api/news'){
    const u = authRequired(req);
    const d = requirePerm(u, 'edit_news'); if(d) return json(res, d.code, { error:d.error });
    const { title, text } = await readBody(req);
    if(!title || !text) return json(res, 400, { error:'title и text обязательны' });
    DB.news.push({ id: crypto.randomUUID(), title, text, author: u.nickname, date: Date.now() });
    saveDB();
    tgAudit('📰 Новость', { автор: u.nickname, заголовок: title });
    return json(res, 200, { ok:true });
  }

  if(m === 'GET' && pathname === '/api/guides'){
    const u = authRequired(req);
    if(!u) return json(res, 401, { error:'Нет авторизации' });
    return json(res, 200, { guides: DB.guides });
  }
  if(m === 'POST' && pathname === '/api/guides'){
    const u = authRequired(req);
    const d = requirePerm(u, 'upload_guides'); if(d) return json(res, d.code, { error:d.error });
    const { title, text } = await readBody(req);
    if(!title || !text) return json(res, 400, { error:'title и text обязательны' });
    DB.guides.push({ id: crypto.randomUUID(), title, text, author: u.nickname, date: Date.now() });
    saveDB();
    return json(res, 200, { ok:true });
  }

  if(m === 'GET' && pathname === '/api/maps'){
    const u = authRequired(req);
    if(!u) return json(res, 401, { error:'Нет авторизации' });
    return json(res, 200, { maps: DB.maps });
  }
  if(m === 'POST' && pathname === '/api/maps'){
    const u = authRequired(req);
    const d = requirePerm(u, 'upload_maps'); if(d) return json(res, d.code, { error:d.error });
    const { name, link } = await readBody(req);
    if(!name || !link) return json(res, 400, { error:'name и link обязательны' });
    DB.maps.push({ id: crypto.randomUUID(), name, link, author: u.nickname, date: Date.now() });
    saveDB();
    return json(res, 200, { ok:true });
  }

  if(m === 'GET' && pathname === '/api/staff'){
    const u = authRequired(req);
    const d = requirePerm(u, 'staff_chat'); if(d) return json(res, d.code, { error:d.error });
    return json(res, 200, { messages: DB.staffChat.slice(-200) });
  }
  if(m === 'POST' && pathname === '/api/staff'){
    const u = authRequired(req);
    const d = requirePerm(u, 'staff_chat'); if(d) return json(res, d.code, { error:d.error });
    const { text } = await readBody(req);
    const t = String(text || '').trim();
    if(!t) return json(res, 400, { error:'Пусто' });
    DB.staffChat.push({ userId: u.id, author: u.nickname, text: t, date: Date.now() });
    saveDB();
    return json(res, 200, { ok:true });
  }

  if(m === 'GET' && pathname.match(/^\/api\/tickets\/(buy|support)$/)){
    const u = authRequired(req);
    if(!u) return json(res, 401, { error:'Нет авторизации' });
    const k = pathname.split('/')[3];
    return json(res, 200, { messages: DB.tickets[k].slice(-200) });
  }
  if(m === 'POST' && pathname.match(/^\/api\/tickets\/(buy|support)$/)){
    const u = authRequired(req);
    if(!u) return json(res, 401, { error:'Нет авторизации' });
    const k = pathname.split('/')[3];
    const { text } = await readBody(req);
    const t = String(text || '').trim();
    if(!t) return json(res, 400, { error:'Пусто' });
    DB.tickets[k].push({ userId: u.id, author: u.nickname, text: t, date: Date.now() });
    saveDB();
    return json(res, 200, { ok:true });
  }

  return json(res, 404, { error:'Не найдено' });
}

/* ============ HTTP SERVER ============ */
const server = http.createServer(async (req, res) => {
  try{
    const url = new URL(req.url, BASE_URL);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }

    if(pathname === '/' || pathname === '/index.html'){
      if(!fs.existsSync(HTML_FILE)){
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('index.html не найден рядом с server.js');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(HTML_FILE, 'utf8'));
    }
    if(pathname.startsWith('/api/')) return handleApi(req, res, pathname);

    res.writeHead(404); res.end('Not found');
  } catch(e){
    console.error('❌', e);
    tgAudit('💥 Ошибка сервера', { message: e.message, url: req.url });
    try{ json(res, 500, { error:'Внутренняя ошибка' }); }catch{}
  }
});

server.listen(PORT, () => {
  console.log('\n╔═════════════════════════════════════════════╗');
  console.log('║           MFMIR сервер запущен              ║');
  console.log('╠═════════════════════════════════════════════╣');
  console.log('║  URL:    ' + BASE_URL.padEnd(33) + '║');
  console.log('║  Порт:   ' + String(PORT).padEnd(33) + '║');
  console.log('║  SMTP:   ' + (SMTP.host ? '✅ ' + SMTP.host : '⚠ нет (в консоль)').padEnd(33) + '║');
  console.log('║  TG:     ' + (TG.enabled ? '✅ аудит включён' : '⚠ выключен').padEnd(33) + '║');
  console.log('╚═════════════════════════════════════════════╝\n');
  tgAudit('🚀 Сервер MFMIR запущен', { url: BASE_URL });
});