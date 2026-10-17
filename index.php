<?php
require 'config.php';

$page   = $_GET['page'] ?? 'home';
$action = $_POST['action'] ?? $_GET['action'] ?? '';

/* ================= API ================= */
if ($page === 'api') {
    header('Content-Type: application/json; charset=utf-8');
    $type = $_GET['type'] ?? '';
    if ($type === 'messages') {
        $since = (int)($_GET['since'] ?? 0);
        $s = $db->prepare("SELECT * FROM chat_messages WHERE id > ? ORDER BY id LIMIT 100");
        $s->execute([$since]);
        echo json_encode($s->fetchAll(), JSON_UNESCAPED_UNICODE); exit;
    }
    if ($type === 'roblox_send') {
        if (($_POST['key'] ?? '') !== ROBLOX_API_KEY) { echo json_encode(['error'=>'forbidden']); exit; }
        $name = trim($_POST['username'] ?? 'Roblox');
        $msg  = trim($_POST['message'] ?? '');
        if ($msg !== '') $db->prepare("INSERT INTO chat_messages(username,message,source) VALUES(?,?,'roblox')")->execute([$name, $msg]);
        echo json_encode(['ok' => true]); exit;
    }
    echo json_encode(['error' => 'unknown']); exit;
}

/* ================= AUTH ================= */
if ($action === 'register') {
    $u = trim($_POST['username'] ?? ''); $p = $_POST['password'] ?? '';
    if (mb_strlen($u) < 3 || strlen($p) < 4) flash('Логин от 3 символов, пароль от 4', 'error');
    else {
        $chk = $db->prepare("SELECT id FROM users WHERE username=?"); $chk->execute([$u]);
        if ($chk->fetch()) flash('Логин занят', 'error');
        else {
            $db->prepare("INSERT INTO users(username,password) VALUES(?,?)")->execute([$u, password_hash($p, PASSWORD_DEFAULT)]);
            $_SESSION['uid'] = $db->lastInsertId();
            flash('Добро пожаловать!'); redirect('index.php');
        }
    }
    redirect('index.php?page=register');
}
if ($action === 'login') {
    $stmt = $db->prepare("SELECT * FROM users WHERE username=?"); $stmt->execute([trim($_POST['username'] ?? '')]);
    $user = $stmt->fetch();
    if ($user && password_verify($_POST['password'] ?? '', $user['password'])) {
        $_SESSION['uid'] = $user['id']; flash('Вы вошли'); redirect('index.php');
    }
    flash('Неверные данные', 'error'); redirect('index.php?page=login');
}
if ($action === 'logout') { session_destroy(); redirect('index.php'); }

/* ================= FORUM ================= */
if ($action === 'create_topic') {
    require_login(); $uid = current_user()['id'];
    $cid = (int)$_POST['category_id']; $t = trim($_POST['title'] ?? ''); $c = trim($_POST['content'] ?? '');
    if ($t && $c) {
        $db->prepare("INSERT INTO forum_topics(category_id,user_id,title) VALUES(?,?,?)")->execute([$cid, $uid, $t]);
        $tid = $db->lastInsertId();
        $db->prepare("INSERT INTO forum_posts(topic_id,user_id,content) VALUES(?,?,?)")->execute([$tid, $uid, $c]);
        flash('Тема создана'); redirect('index.php?page=forum_topic&id=' . $tid);
    }
    flash('Заполните все поля', 'error'); redirect('index.php?page=forum&cat=' . $cid);
}
if ($action === 'reply') {
    require_login(); $uid = current_user()['id']; $tid = (int)$_POST['topic_id']; $c = trim($_POST['content'] ?? '');
    if ($c) { $db->prepare("INSERT INTO forum_posts(topic_id,user_id,content) VALUES(?,?,?)")->execute([$tid, $uid, $c]); flash('Ответ добавлен'); }
    redirect('index.php?page=forum_topic&id=' . $tid);
}

/* ================= CHAT ================= */
if ($action === 'chat_send') {
    require_login(); $u = current_user(); $msg = trim($_POST['message'] ?? '');
    if ($msg !== '') $db->prepare("INSERT INTO chat_messages(user_id,username,message) VALUES(?,?,?)")->execute([$u['id'], $u['username'], $msg]);
    if (!empty($_POST['ajax'])) { header('Content-Type: application/json'); echo json_encode(['ok'=>true]); exit; }
    redirect('index.php?page=chat');
}

/* ================= COMPLAINTS / IDEAS ================= */
if ($action === 'complaint') {
    require_login(); $uid = current_user()['id'];
    $type = in_array($_POST['type'] ?? '', ['player','admin','discord']) ? $_POST['type'] : 'player';
    $t = trim($_POST['target'] ?? ''); $r = trim($_POST['reason'] ?? '');
    if ($t && $r) { $db->prepare("INSERT INTO complaints(user_id,type,target,reason) VALUES(?,?,?,?)")->execute([$uid,$type,$t,$r]); flash('Жалоба отправлена'); }
    else flash('Заполните поля', 'error');
    redirect('index.php?page=complaints');
}
if ($action === 'complaint_status' && can('manage_users')) {
    $id = (int)$_POST['id']; $st = in_array($_POST['status'] ?? '', ['pending','approved','rejected']) ? $_POST['status'] : 'pending';
    $db->prepare("UPDATE complaints SET status=? WHERE id=?")->execute([$st, $id]);
    redirect('index.php?page=complaints');
}
if ($action === 'idea') {
    require_login(); $uid = current_user()['id'];
    $t = trim($_POST['title'] ?? ''); $c = trim($_POST['content'] ?? '');
    if ($t && $c) { $db->prepare("INSERT INTO ideas(user_id,title,content) VALUES(?,?,?)")->execute([$uid,$t,$c]); flash('Идея отправлена'); }
    else flash('Заполните поля', 'error');
    redirect('index.php?page=ideas');
}

/* ================= FACTION ================= */
if ($action === 'faction_join') {
    require_login(); $uid = current_user()['id']; $fid = (int)$_POST['faction_id'];
    $db->prepare("DELETE FROM faction_members WHERE user_id=?")->execute([$uid]);
    $db->prepare("INSERT INTO faction_members(user_id,faction_id) VALUES(?,?)")->execute([$uid, $fid]);
    flash('Вы вступили во фракцию'); redirect('index.php?page=factions');
}
if ($action === 'faction_rank' && can('manage_users')) {
    $db->prepare("UPDATE faction_members SET rank=? WHERE id=?")->execute([trim($_POST['rank'] ?? ''), (int)$_POST['member_id']]);
    flash('Ранг обновлён'); redirect('index.php?page=factions');
}

/* ================= RECRUITMENT APPLY ================= */
if ($action === 'apply') {
    require_login(); $uid = current_user()['id']; $rid = (int)$_POST['recruitment_id'];
    $chk = $db->prepare("SELECT id FROM applications WHERE user_id=? AND recruitment_id=? AND status='pending'");
    $chk->execute([$uid, $rid]);
    if ($chk->fetch()) { flash('У вас уже есть активная заявка', 'error'); redirect('index.php?page=cabinet'); }
    $answers = [];
    foreach ($db->query("SELECT * FROM recruitment_fields ORDER BY sort")->fetchAll() as $f) {
        $answers[] = ['label' => $f['label'], 'value' => trim($_POST['field_' . $f['id']] ?? '')];
    }
    $db->prepare("INSERT INTO applications(user_id,recruitment_id,answers) VALUES(?,?,?)")->execute([$uid, $rid, json_encode($answers, JSON_UNESCAPED_UNICODE)]);
    flash('Заявка отправлена'); redirect('index.php?page=cabinet');
}

/* ================= ADMIN ================= */
if ($action === 'admin_user_role' && can('manage_users')) {
    $role = $_POST['role'];
    $chk = $db->prepare("SELECT id FROM roles WHERE name=?"); $chk->execute([$role]);
    if ($chk->fetch()) { $db->prepare("UPDATE users SET role=? WHERE id=?")->execute([$role, (int)$_POST['user_id']]); flash('Роль обновлена'); }
    redirect('index.php?page=admin&tab=users');
}
if ($action === 'admin_create_role' && is_owner()) {
    $name = strtolower(preg_replace('/[^a-zA-Z0-9_]/', '', $_POST['name'] ?? ''));
    $label = trim($_POST['label'] ?? ''); $perms = $_POST['perms'] ?? [];
    if ($name && $label) {
        try { $db->prepare("INSERT INTO roles(name,label,perms) VALUES(?,?,?)")->execute([$name, $label, json_encode($perms)]); flash('Роль создана'); }
        catch (Exception $e) { flash('Роль уже существует', 'error'); }
    }
    redirect('index.php?page=admin&tab=roles');
}
if ($action === 'admin_delete_role' && is_owner()) {
    $r = $db->prepare("SELECT name FROM roles WHERE id=?"); $r->execute([(int)$_POST['role_id']]);
    $row = $r->fetch();
    if ($row && !in_array($row['name'], ['owner','admin','moderator','user'])) {
        $db->prepare("DELETE FROM roles WHERE id=?")->execute([(int)$_POST['role_id']]); flash('Роль удалена');
    }
    redirect('index.php?page=admin&tab=roles');
}
if ($action === 'recruitment_toggle' && can('manage_recruitment')) {
    $r = $db->query("SELECT * FROM recruitment LIMIT 1")->fetch();
    if ($r) { $db->prepare("UPDATE recruitment SET is_open=? WHERE id=?")->execute([$r['is_open'] ? 0 : 1, $r['id']]); flash('Статус набора переключён'); }
    redirect('index.php?page=admin&tab=recruitment');
}
if ($action === 'recruitment_add_field' && can('manage_recruitment')) {
    $label = trim($_POST['label'] ?? ''); $type = in_array($_POST['type'], ['text','textarea','number','email']) ? $_POST['type'] : 'text';
    if ($label) {
        $max = $db->query("SELECT COALESCE(MAX(sort),0) m FROM recruitment_fields")->fetch()['m'];
        $db->prepare("INSERT INTO recruitment_fields(label,type,sort) VALUES(?,?,?)")->execute([$label, $type, $max + 1]); flash('Поле добавлено');
    }
    redirect('index.php?page=admin&tab=recruitment');
}
if ($action === 'recruitment_del_field' && can('manage_recruitment')) {
    $db->prepare("DELETE FROM recruitment_fields WHERE id=?")->execute([(int)$_POST['field_id']]);
    redirect('index.php?page=admin&tab=recruitment');
}
if ($action === 'app_status' && can('manage_apps')) {
    $id = (int)$_POST['app_id'];
    $st = in_array($_POST['status'] ?? '', ['approved','rejected','pending']) ? $_POST['status'] : 'pending';
    $a = $db->prepare("SELECT a.*, r.role_to_assign FROM applications a JOIN recruitment r ON r.id=a.recruitment_id WHERE a.id=?"); $a->execute([$id]);
    $row = $a->fetch();
    if ($row) {
        $db->prepare("UPDATE applications SET status=? WHERE id=?")->execute([$st, $id]);
        if ($st === 'approved') $db->prepare("UPDATE users SET role=? WHERE id=?")->execute([$row['role_to_assign'], $row['user_id']]);
        flash('Статус заявки обновлён');
    }
    redirect('index.php?page=admin&tab=apps');
}

/* ================= LAYOUT ================= */
$user  = current_user();
$flash = get_flash();
?>
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Adrenaline RP</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="topbar">
  <div class="container nav">
    <a href="index.php" class="logo">⚡ Adrenaline<span>RP</span></a>
    <nav>
      <a href="index.php?page=forum">Форум</a>
      <a href="index.php?page=chat">Чат</a>
      <a href="index.php?page=factions">Фракции</a>
      <a href="index.php?page=recruitment">Набор</a>
      <a href="index.php?page=complaints">Жалобы</a>
      <a href="index.php?page=ideas">Идеи</a>
      <?php if ($user && is_admin()): ?><a href="index.php?page=admin" class="hot">Админка</a><?php endif; ?>
    </nav>
    <div class="user">
      <?php if ($user): ?>
        <a href="index.php?page=cabinet" class="avatar"><?= e(mb_substr($user['username'], 0, 1)) ?></a>
        <span class="uname"><?= e($user['username']) ?></span>
        <form method="post" style="display:inline"><input type="hidden" name="action" value="logout"><button class="btn small ghost">Выйти</button></form>
      <?php else: ?>
        <a class="btn small" href="index.php?page=login">Вход</a>
        <a class="btn small primary" href="index.php?page=register">Регистрация</a>
      <?php endif; ?>
    </div>
  </div>
</header>
<main class="container">
<?php if ($flash): ?><div class="flash <?= e($flash['type']) ?>"><?= e($flash['msg']) ?></div><?php endif; ?>

<?php switch ($page):

/* ---------- HOME ---------- */
case 'home': ?>
  <section class="hero">
    <div class="hero-badge">Adrenaline Role Play</div>
    <h1>Живи свою <span>роль</span>.</h1>
    <p>Добро пожаловать на официальный сайт сервера Adrenaline RP. Форум, чат, фракции, набор в администрацию и личный кабинет — всё в одном месте.</p>
    <div class="hero-actions">
      <a href="index.php?page=forum" class="btn primary">Перейти на форум</a>
      <a href="index.php?page=recruitment" class="btn">Набор в админы</a>
    </div>
  </section>
  <div class="grid cols-4">
    <div class="stat"><div class="num"><?= $db->query("SELECT COUNT(*) c FROM users")->fetch()['c'] ?></div><div class="lbl">Игроков</div></div>
    <div class="stat"><div class="num"><?= $db->query("SELECT COUNT(*) c FROM forum_topics")->fetch()['c'] ?></div><div class="lbl">Тем на форуме</div></div>
    <div class="stat"><div class="num"><?= $db->query("SELECT COUNT(*) c FROM faction_members")->fetch()['c'] ?></div><div class="lbl">Во фракциях</div></div>
    <div class="stat"><div class="num"><?= $db->query("SELECT COUNT(*) c FROM chat_messages")->fetch()['c'] ?></div><div class="lbl">Сообщений</div></div>
  </div>
<?php break;

/* ---------- LOGIN / REGISTER ---------- */
case 'login': ?>
  <div class="auth-card">
    <h2>Вход</h2>
    <form method="post">
      <input type="hidden" name="action" value="login">
      <label>Логин<input name="username" required autofocus></label>
      <label>Пароль<input type="password" name="password" required></label>
      <button class="btn primary full">Войти</button>
    </form>
    <p class="muted">Нет аккаунта? <a href="index.php?page=register">Регистрация</a></p>
  </div>
<?php break;

case 'register': ?>
  <div class="auth-card">
    <h2>Регистрация</h2>
    <form method="post">
      <input type="hidden" name="action" value="register">
      <label>Логин<input name="username" required minlength="3"></label>
      <label>Пароль<input type="password" name="password" required minlength="4"></label>
      <button class="btn primary full">Создать аккаунт</button>
    </form>
    <p class="muted">Уже есть аккаунт? <a href="index.php?page=login">Войти</a></p>
  </div>
<?php break;

/* ---------- FORUM ---------- */
case 'forum':
  $cat = (int)($_GET['cat'] ?? 0);
  if ($cat) {
      $c = $db->prepare("SELECT * FROM forum_categories WHERE id=?"); $c->execute([$cat]); $c = $c->fetch();
      if (!$c) { echo '<div class="empty">Категория не найдена</div>'; break; }
      $topics = $db->prepare("SELECT t.*, u.username, (SELECT COUNT(*) FROM forum_posts p WHERE p.topic_id=t.id) cnt FROM forum_topics t JOIN users u ON u.id=t.user_id WHERE t.category_id=? ORDER BY t.id DESC");
      $topics->execute([$cat]); $topics = $topics->fetchAll();
      ?>
      <div class="page-head">
        <div>
          <a href="index.php?page=forum" class="crumb">← Все категории</a>
          <h2><?= e($c['name']) ?></h2>
          <p class="muted"><?= e($c['description']) ?></p>
        </div>
        <button class="btn primary" onclick="document.getElementById('new-topic').classList.toggle('hidden')">+ Новая тема</button>
      </div>
      <div id="new-topic" class="<?= $user ? 'hidden' : 'hidden' ?> panel">
        <?php if ($user): ?>
        <form method="post" class="form">
          <input type="hidden" name="action" value="create_topic">
          <input type="hidden" name="category_id" value="<?= $cat ?>">
          <label>Заголовок<input name="title" required maxlength="120"></label>
          <label>Сообщение<textarea name="content" rows="5" required></textarea></label>
          <button class="btn primary">Создать тему</button>
        </form>
        <?php else: ?>
          <p class="muted">Войдите, чтобы создавать темы.</p>
        <?php endif; ?>
      </div>
      <div class="list">
        <?php if (!$topics): ?><div class="empty">Тем пока нет. Создайте первую!</div><?php endif; ?>
        <?php foreach ($topics as $t): ?>
          <a class="list-item" href="index.php?page=forum_topic&id=<?= $t['id'] ?>">
            <div class="avatar sm"><?= e(mb_substr($t['username'],0,1)) ?></div>
            <div class="flex1">
              <div class="title"><?= e($t['title']) ?></div>
              <div class="meta"><?= e($t['username']) ?> · <?= e($t['created_at']) ?></div>
            </div>
            <div class="pill"><?= $t['cnt'] ?> сообщ.</div>
          </a>
        <?php endforeach; ?>
      </div>
      <?php
  } else {
      $cats = $db->query("SELECT c.*, (SELECT COUNT(*) FROM forum_topics t WHERE t.category_id=c.id) tc, (SELECT COUNT(*) FROM forum_posts p JOIN forum_topics t ON t.id=p.topic_id WHERE t.category_id=c.id) pc FROM forum_categories c ORDER BY c.id")->fetchAll();
      ?>
      <div class="page-head"><h2>Форум</h2><p class="muted">Общайтесь, делитесь опытом и задавайте вопросы</p></div>
      <div class="grid cols-2">
        <?php foreach ($cats as $c): ?>
          <a class="card cat-card" href="index.php?page=forum&cat=<?= $c['id'] ?>">
            <div class="cat-icon">💬</div>
            <div>
              <div class="title"><?= e($c['name']) ?></div>
              <div class="meta"><?= e($c['description']) ?></div>
              <div class="meta small"><?= $c['tc'] ?> тем · <?= $c['pc'] ?> сообщений</div>
            </div>
          </a>
        <?php endforeach; ?>
      </div>
  <?php }
  break;

case 'forum_topic':
  $tid = (int)($_GET['id'] ?? 0);
  $t = $db->prepare("SELECT t.*, u.username, c.name cname, c.id cid FROM forum_topics t JOIN users u ON u.id=t.user_id JOIN forum_categories c ON c.id=t.category_id WHERE t.id=?");
  $t->execute([$tid]); $t = $t->fetch();
  if (!$t) { echo '<div class="empty">Тема не найдена</div>'; break; }
  $posts = $db->prepare("SELECT p.*, u.username, u.role FROM forum_posts p JOIN users u ON u.id=p.user_id WHERE p.topic_id=? ORDER BY p.id");
  $posts->execute([$tid]); $posts = $posts->fetchAll();
  ?>
  <a href="index.php?page=forum&cat=<?= $t['cid'] ?>" class="crumb">← <?= e($t['cname']) ?></a>
  <div class="page-head"><h2><?= e($t['title']) ?></h2></div>
  <div class="posts">
    <?php foreach ($posts as $i => $p): ?>
      <div class="post <?= $i === 0 ? 'op' : '' ?>">
        <div class="post-side">
          <div class="avatar"><?= e(mb_substr($p['username'],0,1)) ?></div>
          <div class="uname"><?= e($p['username']) ?></div>
          <div class="role"><?= e($p['role']) ?></div>
        </div>
        <div class="post-body">
          <div class="meta"><?= e($p['created_at']) ?></div>
          <div class="content"><?= nl2br(e($p['content'])) ?></div>
        </div>
      </div>
    <?php endforeach; ?>
  </div>
  <?php if ($user): ?>
    <div class="panel">
      <form method="post" class="form">
        <input type="hidden" name="action" value="reply">
        <input type="hidden" name="topic_id" value="<?= $tid ?>">
        <label>Ответ<textarea name="content" rows="4" required></textarea></label>
        <button class="btn primary">Отправить</button>
      </form>
    </div>
  <?php else: ?>
    <p class="muted">Войдите, чтобы отвечать.</p>
  <?php endif; ?>
<?php break;

/* ---------- CHAT ---------- */
case 'chat':
  $msgs = $db->query("SELECT * FROM chat_messages ORDER BY id DESC LIMIT 50")->fetchAll();
  $msgs = array_reverse($msgs);
  $lastId = $msgs ? end($msgs)['id'] : 0;
  ?>
  <div class="page-head"><h2>💬 Чат</h2><p class="muted">Общий чат сервера. Сообщения из Roblox тоже здесь.</p></div>
  <div class="chat-box" id="chat-box" data-last="<?= $lastId ?>">
    <?php foreach ($msgs as $m): ?>
      <div class="msg <?= $m['source']==='roblox'?'roblox':'' ?>">
        <span class="who"><?= e($m['username']) ?></span>
        <span class="txt"><?= e($m['message']) ?></span>
        <span class="time"><?= e(substr($m['created_at'],11,5)) ?></span>
      </div>
    <?php endforeach; ?>
  </div>
  <?php if ($user): ?>
    <form id="chat-form" class="chat-form" method="post">
      <input type="hidden" name="action" value="chat_send">
      <input name="message" placeholder="Ваше сообщение..." autocomplete="off" required maxlength="500">
      <button class="btn primary">Отправить</button>
    </form>
  <?php else: ?>
    <div class="panel"><p class="muted">Войдите, чтобы писать в чат. <a href="index.php?page=login">Войти</a></p></div>
  <?php endif; ?>
<?php break;

/* ---------- FACTIONS ---------- */
case 'factions':
  $facs = $db->query("SELECT f.*, (SELECT COUNT(*) FROM faction_members m WHERE m.faction_id=f.id) cnt FROM factions f ORDER BY f.id")->fetchAll();
  $myFac = null;
  if ($user) {
      $s = $db->prepare("SELECT m.*, f.name FROM faction_members m JOIN factions f ON f.id=m.faction_id WHERE m.user_id=?");
      $s->execute([$user['id']]); $myFac = $s->fetch();
  }
  ?>
  <div class="page-head"><h2>🚔 Фракции</h2><p class="muted">Вступите во фракцию или измените состав (для администрации)</p></div>
  <div class="grid cols-3">
    <?php foreach ($facs as $f): ?>
      <div class="card faction-card" style="--c:<?= e($f['color']) ?>">
        <div class="badge-dot"></div>
        <div class="title"><?= e($f['name']) ?></div>
        <div class="meta"><?= e($f['description']) ?></div>
        <div class="meta small">👥 <?= $f['cnt'] ?> участников</div>
        <?php if ($user && (!$myFac || $myFac['faction_id'] != $f['id'])): ?>
          <form method="post"><input type="hidden" name="action" value="faction_join"><input type="hidden" name="faction_id" value="<?= $f['id'] ?>"><button class="btn small primary">Вступить</button></form>
        <?php elseif ($user && $myFac && $myFac['faction_id'] == $f['id']): ?>
          <div class="badge ok">Вы здесь · <?= e($myFac['rank']) ?></div>
        <?php endif; ?>
      </div>
    <?php endforeach; ?>
  </div>

  <?php if ($myFac): ?>
    <div class="panel">
      <h3>👤 Состав «<?= e($myFac['name']) ?>»</h3>
      <?php $members = $db->prepare("SELECT m.*, u.username FROM faction_members m JOIN users u ON u.id=m.user_id WHERE m.faction_id=? ORDER BY m.id");
      $members->execute([$myFac['faction_id']]); ?>
      <table class="tbl">
        <tr><th>Игрок</th><th>Ранг</th><?php if (can('manage_users')): ?><th>Изменить</th><?php endif; ?></tr>
        <?php foreach ($members->fetchAll() as $m): ?>
          <tr>
            <td><?= e($m['username']) ?></td>
            <td><?= e($m['rank']) ?></td>
            <?php if (can('manage_users')): ?>
              <td>
                <form method="post" style="display:flex;gap:6px">
                  <input type="hidden" name="action" value="faction_rank">
                  <input type="hidden" name="member_id" value="<?= $m['id'] ?>">
                  <input name="rank" value="<?= e($m['rank']) ?>" style="padding:6px 8px">
                  <button class="btn small">OK</button>
                </form>
              </td>
            <?php endif; ?>
          </tr>
        <?php endforeach; ?>
      </table>
    </div>
  <?php endif;
  break;

/* ---------- RECRUITMENT ---------- */
case 'recruitment':
  $r = $db->query("SELECT * FROM recruitment LIMIT 1")->fetch();
  if (!$r) { echo '<div class="empty">Набор не настроен</div>'; break; }
  $applied = false;
  if ($user) { $chk = $db->prepare("SELECT id,status FROM applications WHERE user_id=? AND recruitment_id=? ORDER BY id DESC LIMIT 1"); $chk->execute([$user['id'],$r['id']]); $a = $chk->fetch(); if ($a) $applied = $a; }
  ?>
  <div class="page-head">
    <div><h2>📋 <?= e($r['title']) ?></h2><p class="muted"><?= e($r['description']) ?></p></div>
    <div><?= $r['is_open'] ? '<span class="badge ok">Набор открыт</span>' : '<span class="badge err">Набор закрыт</span>' ?></div>
  </div>
  <?php if (!$user): ?>
    <div class="panel"><p>Чтобы подать заявку, <a href="index.php?page=login">войдите</a> или <a href="index.php?page=register">зарегистрируйтесь</a>.</p></div>
  <?php elseif (!$r['is_open']): ?>
    <div class="panel"><p class="muted">Набор временно закрыт. Следите за новостями.</p></div>
  <?php elseif ($applied): ?>
    <div class="panel"><p>Вы уже подали заявку. Статус: <?= status_badge($applied['status']) ?></p><p class="muted">Следить за статусом можно в <a href="index.php?page=cabinet">личном кабинете</a>.</p></div>
  <?php else: ?>
    <div class="panel">
      <form method="post" class="form">
        <input type="hidden" name="action" value="apply">
        <input type="hidden" name="recruitment_id" value="<?= $r['id'] ?>">
        <?php foreach ($db->query("SELECT * FROM recruitment_fields ORDER BY sort")->fetchAll() as $f): ?>
          <label><?= e($f['label']) ?>
            <?php if ($f['type'] === 'textarea'): ?>
              <textarea name="field_<?= $f['id'] ?>" rows="4" required></textarea>
            <?php else: ?>
              <input type="<?= e($f['type']) ?>" name="field_<?= $f['id'] ?>" required>
            <?php endif; ?>
          </label>
        <?php endforeach; ?>
        <button class="btn primary">Отправить заявку</button>
      </form>
    </div>
  <?php endif;
  break;

/* ---------- CABINET ---------- */
case 'cabinet':
  require_login();
  $apps = $db->prepare("SELECT a.*, r.title FROM applications a JOIN recruitment r ON r.id=a.recruitment_id WHERE a.user_id=? ORDER BY a.id DESC");
  $apps->execute([$user['id']]);
  $comp = $db->prepare("SELECT * FROM complaints WHERE user_id=? ORDER BY id DESC"); $comp->execute([$user['id']]);
  $ideas = $db->prepare("SELECT * FROM ideas WHERE user_id=? ORDER BY id DESC"); $ideas->execute([$user['id']]);
  $fac = $db->prepare("SELECT m.rank, f.name, f.color FROM faction_members m JOIN factions f ON f.id=m.faction_id WHERE m.user_id=?");
  $fac->execute([$user['id']]); $fac = $fac->fetch();
  ?>
  <div class="page-head"><h2>👤 Личный кабинет</h2></div>
  <div class="grid cols-2">
    <div class="card">
      <div class="avatar big"><?= e(mb_substr($user['username'],0,1)) ?></div>
      <div class="title"><?= e($user['username']) ?></div>
      <div class="meta">Роль: <b><?= e($user['role']) ?></b></div>
      <div class="meta">Регистрация: <?= e($user['created_at']) ?></div>
      <?php if ($fac): ?><div class="meta">Фракция: <b style="color:<?= e($fac['color']) ?>"><?= e($fac['name']) ?></b> · <?= e($fac['rank']) ?></div><?php endif; ?>
    </div>
    <div class="card">
      <div class="title">📨 Мои заявки</div>
      <?php $aList = $apps->fetchAll(); if (!$aList): ?><div class="muted">Заявок нет</div><?php endif; ?>
      <?php foreach ($aList as $a): ?>
        <div class="line"><span><?= e($a['title']) ?></span><?= status_badge($a['status']) ?></div>
      <?php endforeach; ?>
    </div>
    <div class="card">
      <div class="title">⚠️ Мои жалобы</div>
      <?php $cList = $comp->fetchAll(); if (!$cList): ?><div class="muted">Жалоб нет</div><?php endif; ?>
      <?php foreach ($cList as $c): ?>
        <div class="line"><span><?= e($c['type']) ?>: <?= e($c['target']) ?></span><?= status_badge($c['status']) ?></div>
      <?php endforeach; ?>
    </div>
    <div class="card">
      <div class="title">💡 Мои идеи</div>
      <?php $iList = $ideas->fetchAll(); if (!$iList): ?><div class="muted">Идей нет</div><?php endif; ?>
      <?php foreach ($iList as $i): ?>
        <div class="line"><span><?= e($i['title']) ?></span><span class="badge muted"><?= e($i['status']) ?></span></div>
      <?php endforeach; ?>
    </div>
  </div>
<?php break;

/* ---------- COMPLAINTS ---------- */
case 'complaints':
  $all = can('manage_users')
      ? $db->query("SELECT c.*, u.username FROM complaints c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC")->fetchAll()
      : [];
  ?>
  <div class="page-head"><h2>⚠️ Жалобы</h2><p class="muted">Пожалуйста, описывайте ситуацию подробно</p></div>
  <?php if ($user): ?>
    <div class="panel">
      <form method="post" class="form">
        <input type="hidden" name="action" value="complaint">
        <div class="row">
          <label>Тип
            <select name="type">
              <option value="player">На игрока</option>
              <option value="admin">На администратора</option>
              <option value="discord">На Discord</option>
            </select>
          </label>
          <label>Никнейм / Discord<input name="target" required placeholder="Например: Player123"></label>
        </div>
        <label>Причина<textarea name="reason" rows="4" required></textarea></label>
        <button class="btn primary">Отправить жалобу</button>
      </form>
    </div>
  <?php endif; ?>

  <?php if (can('manage_users')): ?>
    <h3>Все жалобы (для администрации)</h3>
    <table class="tbl">
      <tr><th>От</th><th>Тип</th><th>На кого</th><th>Причина</th><th>Статус</th><th>Действие</th></tr>
      <?php foreach ($all as $c): ?>
        <tr>
          <td><?= e($c['username']) ?></td>
          <td><?= e($c['type']) ?></td>
          <td><?= e($c['target']) ?></td>
          <td><?= e(mb_substr($c['reason'],0,80)) ?></td>
          <td><?= status_badge($c['status']) ?></td>
          <td>
            <form method="post" style="display:flex;gap:6px">
              <input type="hidden" name="action" value="complaint_status">
              <input type="hidden" name="id" value="<?= $c['id'] ?>">
              <select name="status">
                <option value="pending">Ожидание</option>
                <option value="approved">Одобрено</option>
                <option value="rejected">Отклонено</option>
              </select>
              <button class="btn small">OK</button>
            </form>
          </td>
        </tr>
      <?php endforeach; ?>
    </table>
  <?php endif;
  break;

/* ---------- IDEAS ---------- */
case 'ideas':
  $list = $db->query("SELECT i.*, u.username FROM ideas i JOIN users u ON u.id=i.user_id ORDER BY i.id DESC")->fetchAll();
  ?>
  <div class="page-head"><h2>💡 Идеи</h2><p class="muted">Предложите улучшение для сервера</p></div>
  <?php if ($user): ?>
    <div class="panel">
      <form method="post" class="form">
        <input type="hidden" name="action" value="idea">
        <label>Заголовок<input name="title" required maxlength="120"></label>
        <label>Описание<textarea name="content" rows="5" required></textarea></label>
        <button class="btn primary">Предложить</button>
      </form>
    </div>
  <?php endif; ?>
  <div class="list">
    <?php foreach ($list as $i): ?>
      <div class="card">
        <div class="title"><?= e($i['title']) ?></div>
        <div class="meta">от <?= e($i['username']) ?> · <?= e($i['created_at']) ?></div>
        <div class="content"><?= nl2br(e($i['content'])) ?></div>
      </div>
    <?php endforeach; ?>
  </div>
<?php break;

/* ---------- ADMIN ---------- */
case 'admin':
  if (!is_admin()) { echo '<div class="empty">Доступ запрещён</div>'; break; }
  $tab = $_GET['tab'] ?? (can('manage_users') ? 'users' : (can('manage_recruitment') ? 'recruitment' : 'apps'));
  $tabs = [];
  if (can('manage_users')) $tabs['users'] = '👥 Пользователи';
  if (is_owner()) $tabs['roles'] = '🔑 Роли';
  if (can('manage_recruitment')) $tabs['recruitment'] = '📋 Набор';
  if (can('manage_apps')) $tabs['apps'] = '📨 Заявки';
  if (!isset($tabs[$tab])) $tab = array_key_first($tabs);
  ?>
  <div class="page-head"><h2>🛠 Панель управления</h2></div>
  <div class="tabs">
    <?php foreach ($tabs as $k => $v): ?>
      <a class="tab <?= $k === $tab ? 'active' : '' ?>" href="index.php?page=admin&tab=<?= $k ?>"><?= $v ?></a>
    <?php endforeach; ?>
  </div>

  <?php if ($tab === 'users'):
      $users = $db->query("SELECT * FROM users ORDER BY id")->fetchAll();
      $roles = $db->query("SELECT * FROM roles ORDER BY id")->fetchAll();
  ?>
    <table class="tbl">
      <tr><th>ID</th><th>Логин</th><th>Роль</th><th>Дата</th><th>Изменить роль</th></tr>
      <?php foreach ($users as $u): ?>
        <tr>
          <td><?= $u['id'] ?></td>
          <td><?= e($u['username']) ?></td>
          <td><b><?= e($u['role']) ?></b></td>
          <td><?= e($u['created_at']) ?></td>
          <td>
            <form method="post" style="display:flex;gap:6px">
              <input type="hidden" name="action" value="admin_user_role">
              <input type="hidden" name="user_id" value="<?= $u['id'] ?>">
              <select name="role">
                <?php foreach ($roles as $r): ?>
                  <option value="<?= e($r['name']) ?>" <?= $u['role']===$r['name']?'selected':'' ?>><?= e($r['label']) ?></option>
                <?php endforeach; ?>
              </select>
              <button class="btn small">OK</button>
            </form>
          </td>
        </tr>
      <?php endforeach; ?>
    </table>
  <?php endif; ?>

  <?php if ($tab === 'roles'):
      $roles = $db->query("SELECT * FROM roles ORDER BY id")->fetchAll();
      $allPerms = ['manage_users' => 'Пользователи', 'manage_forum' => 'Форум',
                   'manage_recruitment' => 'Набор', 'manage_apps' => 'Заявки'];
  ?>
    <h3>Создать роль</h3>
    <div class="panel">
      <form method="post" class="form">
        <input type="hidden" name="action" value="admin_create_role">
        <div class="row">
          <label>Техн. имя (латиница)<input name="name" required pattern="[a-zA-Z0-9_]+" placeholder="curator"></label>
          <label>Название<input name="label" required placeholder="Куратор"></label>
        </div>
        <div class="checks">
          <?php foreach ($allPerms as $k => $v): ?>
            <label class="check"><input type="checkbox" name="perms[]" value="<?= $k ?>"> <?= $v ?></label>
          <?php endforeach; ?>
        </div>
        <button class="btn primary">Создать роль</button>
      </form>
    </div>
    <h3>Существующие роли</h3>
    <table class="tbl">
      <tr><th>Имя</th><th>Название</th><th>Права</th><th></th></tr>
      <?php foreach ($roles as $r): ?>
        <tr>
          <td><code><?= e($r['name']) ?></code></td>
          <td><?= e($r['label']) ?></td>
          <td><?= e(implode(', ', json_decode($r['perms'], true) ?: [])) ?></td>
          <td>
            <?php if (!in_array($r['name'], ['owner','admin','moderator','user'])): ?>
              <form method="post" onsubmit="return confirm('Удалить?')">
                <input type="hidden" name="action" value="admin_delete_role">
                <input type="hidden" name="role_id" value="<?= $r['id'] ?>">
                <button class="btn small danger">Удалить</button>
              </form>
            <?php endif; ?>
          </td>
        </tr>
      <?php endforeach; ?>
    </table>
  <?php endif; ?>

  <?php if ($tab === 'recruitment'):
      $r = $db->query("SELECT * FROM recruitment LIMIT 1")->fetch();
      $fields = $db->query("SELECT * FROM recruitment_fields ORDER BY sort")->fetchAll();
  ?>
    <?php if ($r): ?>
      <div class="card">
        <div class="title"><?= e($r['title']) ?></div>
        <div class="meta"><?= e($r['description']) ?></div>
        <div style="margin:10px 0">Статус: <?= $r['is_open'] ? '<span class="badge ok">Открыт</span>' : '<span class="badge err">Закрыт</span>' ?></div>
        <form method="post"><input type="hidden" name="action" value="recruitment_toggle"><button class="btn <?= $r['is_open']?'danger':'primary' ?>"><?= $r['is_open']?'Закрыть набор':'Открыть набор' ?></button></form>
      </div>
    <?php endif; ?>
    <h3>Поля анкеты</h3>
    <table class="tbl">
      <tr><th>#</th><th>Название</th><th>Тип</th><th></th></tr>
      <?php foreach ($fields as $f): ?>
        <tr>
          <td><?= $f['sort'] ?></td>
          <td><?= e($f['label']) ?></td>
          <td><?= e($f['type']) ?></td>
          <td>
            <form method="post"><input type="hidden" name="action" value="recruitment_del_field"><input type="hidden" name="field_id" value="<?= $f['id'] ?>"><button class="btn small danger">×</button></form>
          </td>
        </tr>
      <?php endforeach; ?>
    </table>
    <div class="panel">
      <h3>Добавить поле</h3>
      <form method="post" class="form">
        <input type="hidden" name="action" value="recruitment_add_field">
        <div class="row">
          <label>Название<input name="label" required></label>
          <label>Тип
            <select name="type">
              <option value="text">Текст</option>
              <option value="textarea">Многострочный</option>
              <option value="number">Число</option>
              <option value="email">Email</option>
            </select>
          </label>
        </div>
        <button class="btn primary">Добавить</button>
      </form>
    </div>
  <?php endif; ?>

  <?php if ($tab === 'apps'):
      $apps = $db->query("SELECT a.*, u.username, r.title FROM applications a JOIN users u ON u.id=a.user_id JOIN recruitment r ON r.id=a.recruitment_id ORDER BY a.id DESC")->fetchAll();
  ?>
    <?php if (!$apps): ?><div class="empty">Заявок пока нет</div><?php endif; ?>
    <?php foreach ($apps as $a): ?>
      <div class="card">
        <div class="row between">
          <div>
            <div class="title"><?= e($a['username']) ?> → <?= e($a['title']) ?></div>
            <div class="meta"><?= e($a['created_at']) ?> · <?= status_badge($a['status']) ?></div>
          </div>
          <div style="display:flex;gap:6px">
            <form method="post"><input type="hidden" name="action" value="app_status"><input type="hidden" name="app_id" value="<?= $a['id'] ?>"><input type="hidden" name="status" value="approved"><button class="btn small ok">Одобрить</button></form>
            <form method="post"><input type="hidden" name="action" value="app_status"><input type="hidden" name="app_id" value="<?= $a['id'] ?>"><input type="hidden" name="status" value="rejected"><button class="btn small danger">Отклонить</button></form>
          </div>
        </div>
        <div class="answers">
          <?php foreach (json_decode($a['answers'], true) ?: [] as $ans): ?>
            <div class="ans"><b><?= e($ans['label']) ?>:</b> <?= nl2br(e($ans['value'])) ?></div>
          <?php endforeach; ?>
        </div>
      </div>
    <?php endforeach; ?>
  <?php endif;
  break;

default: echo '<div class="empty">404 — страница не найдена</div>';
endswitch; ?>
</main>
<footer class="footer"><div class="container">© <?= date('Y') ?> Adrenaline RP · Powered by PHP</div></footer>
<script src="app.js"></script>
</body></html>