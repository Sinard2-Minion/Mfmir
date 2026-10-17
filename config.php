<?php
if (session_status() === PHP_SESSION_NONE) session_start();

define('DB_FILE', __DIR__ . '/adrenaline.sqlite');
define('ROBLOX_API_KEY', 'ADRENALINE_KEY'); // смените!

try {
    $db = new PDO('sqlite:' . DB_FILE);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $db->exec('PRAGMA foreign_keys = ON');
} catch (Exception $e) { die('DB error: ' . $e->getMessage()); }

/* ---------- MIGRATIONS ---------- */
$tables = [
"CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', avatar TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, label TEXT NOT NULL, perms TEXT DEFAULT '[]')",
"CREATE TABLE IF NOT EXISTS factions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', color TEXT DEFAULT '#3b82f6')",
"CREATE TABLE IF NOT EXISTS faction_members (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, faction_id INTEGER NOT NULL, rank TEXT DEFAULT 'Участник')",
"CREATE TABLE IF NOT EXISTS forum_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '')",
"CREATE TABLE IF NOT EXISTS forum_topics (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, user_id INTEGER NOT NULL, title TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS forum_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL, user_id INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT NOT NULL, message TEXT NOT NULL, source TEXT DEFAULT 'site', created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS complaints (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, status TEXT DEFAULT 'new', created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS recruitment (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '', is_open INTEGER DEFAULT 1, role_to_assign TEXT DEFAULT 'admin')",
"CREATE TABLE IF NOT EXISTS recruitment_fields (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, type TEXT DEFAULT 'text', sort INTEGER DEFAULT 0)",
"CREATE TABLE IF NOT EXISTS applications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, recruitment_id INTEGER NOT NULL, answers TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))"
];
foreach ($tables as $sql) $db->exec($sql);

/* ---------- SEED ---------- */
if ($db->query("SELECT COUNT(*) c FROM users")->fetch()['c'] == 0) {
    $db->prepare("INSERT INTO users(username,password,role) VALUES(?,?,?)")
       ->execute(['owner', password_hash('owner123', PASSWORD_DEFAULT), 'owner']);
    $db->exec("INSERT INTO roles(name,label,perms) VALUES
        ('owner','Владелец','[\"all\"]'),
        ('admin','Администратор','[\"manage_users\",\"manage_recruitment\",\"manage_apps\",\"manage_forum\"]'),
        ('moderator','Модератор','[\"manage_forum\"]'),
        ('user','Игрок','[]')");
    $db->exec("INSERT INTO factions(name,description,color) VALUES
        ('Police Department','Полицейский департамент','#3b82f6'),
        ('EMS','Скорая помощь','#ef4444'),
        ('FBI','Федеральное бюро','#8b5cf6'),
        ('Grove Street','Уличная банда','#22c55e'),
        ('Marabunta Grande','Банда','#f59e0b')");
    $db->exec("INSERT INTO forum_categories(name,description) VALUES
        ('Новости','Официальные новости сервера'),
        ('Обсуждения','Общение игроков'),
        ('Гайды','Полезные гайды'),
        ('Баг-репорт','Сообщения об ошибках')");
    $db->exec("INSERT INTO recruitment(title,description,is_open,role_to_assign) VALUES('Набор в администрацию','Ищем активных и ответственных администраторов!',1,'admin')");
    $db->exec("INSERT INTO recruitment_fields(label,type,sort) VALUES
        ('Ваше имя','text',1),('Возраст','number',2),('Discord','text',3),
        ('Опыт администрирования','textarea',4),('Почему именно вы?','textarea',5)");
}

/* ---------- HELPERS ---------- */
function e($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function redirect($u) { header('Location: ' . $u); exit; }
function current_user() {
    global $db;
    if (empty($_SESSION['uid'])) return null;
    static $u = false;
    if ($u === false) {
        $s = $db->prepare("SELECT * FROM users WHERE id=?");
        $s->execute([$_SESSION['uid']]);
        $u = $s->fetch() ?: null;
    }
    return $u;
}
function is_owner() { $u = current_user(); return $u && $u['role'] === 'owner'; }
function can($perm) {
    $u = current_user();
    if (!$u) return false;
    if ($u['role'] === 'owner') return true;
    global $db;
    $s = $db->prepare("SELECT perms FROM roles WHERE name=?");
    $s->execute([$u['role']]);
    $r = $s->fetch();
    if (!$r) return false;
    $p = json_decode($r['perms'], true) ?: [];
    return in_array('all', $p) || in_array($perm, $p);
}
function is_admin() {
    return can('manage_forum') || can('manage_users') || can('manage_apps') || can('manage_recruitment') || is_owner();
}
function require_login() { if (!current_user()) redirect('index.php?page=login'); }
function flash($msg, $type = 'success') { $_SESSION['flash'] = ['msg' => $msg, 'type' => $type]; }
function get_flash() { $f = $_SESSION['flash'] ?? null; unset($_SESSION['flash']); return $f; }
function status_badge($s) {
    $map = ['pending' => ['На рассмотрении', 'warn'], 'approved' => ['Одобрено', 'ok'],
            'rejected' => ['Отклонено', 'err'], 'new' => ['Новая', 'warn'], 'open' => ['Открыт', 'ok']];
    $m = $map[$s] ?? [$s, 'muted'];
    return '<span class="badge ' . $m[1] . '">' . e($m[0]) . '</span>';
}