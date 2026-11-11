<?php
/* /swing/ds/sync/  History of token updates sent from the Figma plugin (with Undo) and the access keys.
   Owner-only: password login. */
declare(strict_types=1);
require __DIR__ . '/lib.php';

header('Cache-Control: no-store');
header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'none'");

if (!is_dir(sds_data()) || !is_file(sds_data() . '/admin.json')) { http_response_code(503); echo 'Sync is not set up on the server.'; exit; }

session_name('sdssync');
$local = preg_match('/^127\.0\.0\.1(:\d+)?$/', $_SERVER['HTTP_HOST'] ?? '') && ($_SERVER['REMOTE_ADDR'] ?? '') === '127.0.0.1';   // the e2e test over plain http
session_set_cookie_params(['lifetime' => 0, 'path' => dirname($_SERVER['SCRIPT_NAME']) . '/', 'secure' => !$local, 'httponly' => true, 'samesite' => 'Strict']);
session_start();
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));

function flash(string $kind, string $msg): void { $_SESSION['flash'][] = [$kind, $msg]; }
function back(): void { header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'), true, 303); exit; }

/* ---------- login ---------- */
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
if (($_POST['do'] ?? '') === 'login') {
  $tries = array_filter(sds_read_json('login.json', []), function ($t) { return $t['at'] > time() - 900; });
  $mine = array_filter($tries, function ($t) use ($ip) { return $t['ip'] === $ip; });
  $admin = sds_read_json('admin.json', []);
  if (count($mine) >= 10) flash('bad', 'Too many tries. Wait 15 minutes.');
  elseif (isset($admin['hash']) && password_verify((string)($_POST['password'] ?? ''), $admin['hash'])) {
    session_regenerate_id(true); $_SESSION['owner'] = true; $_SESSION['csrf'] = bin2hex(random_bytes(16));
  } else {
    sleep(1); $tries[] = ['ip' => $ip, 'at' => time()]; sds_write_json('login.json', array_values($tries));
    flash('bad', 'Wrong password.');
  }
  back();
}
$owner = !empty($_SESSION['owner']);

/* ---------- actions ---------- */
if ($owner && $_SERVER['REQUEST_METHOD'] === 'POST') {
  if (!hash_equals($_SESSION['csrf'], (string)($_POST['csrf'] ?? ''))) { flash('bad', 'Form expired. Try again.'); back(); }
  $do = (string)($_POST['do'] ?? '');
  $lock = sds_lock();
  try {
    if ($do === 'logout') { $_SESSION = []; session_destroy(); }
    elseif ($do === 'restore') {
      $f = (string)($_POST['backup'] ?? '');
      $p = sds_data() . '/backups/' . $f;
      if (!preg_match('/^tokens-\d{8}-\d{6}-[0-9a-f]{4}\.css$/', $f) || !is_file($p)) flash('bad', 'Backup not found.');
      else {
        $bak = sds_backup_tokens((string)file_get_contents(sds_tokens_path()));
        sds_write_tokens((string)file_get_contents($p));
        sds_history_add(['action' => 'restore', 'from' => $f, 'backup' => $bak]);
        flash('ok', 'tokens.css is back to how it was before that update. Import tokens in Figma to match.');
      }
    }
    elseif ($do === 'add-member') {
      $nm = trim((string)($_POST['name'] ?? ''));
      if ($nm === '' || mb_strlen($nm) > 40) flash('bad', 'Name: 1 to 40 characters.');
      else {
        $key = 'sds_' . bin2hex(random_bytes(20));
        $keys = sds_read_json('keys.json', []);
        $keys[] = ['id' => bin2hex(random_bytes(4)), 'name' => $nm, 'hash' => sds_key_hash($key), 'created' => time()];
        sds_write_json('keys.json', $keys);
        $_SESSION['newkey'] = [$nm, $key];
      }
    }
    elseif ($do === 'revoke') {
      $id = (string)($_POST['id'] ?? ''); $keys = sds_read_json('keys.json', []);
      foreach ($keys as &$k) if ($k['id'] === $id) $k['revoked'] = time();
      unset($k);
      sds_write_json('keys.json', $keys);
      flash('ok', 'Key revoked.');
    }
  } catch (Throwable $e) { flash('bad', $e->getMessage()); }
  finally { sds_unlock($lock); }
  back();
}

/* ---------- view ---------- */
$css = (string)@file_get_contents(sds_tokens_path());
function color_of(string $css, string $v): ?string {
  for ($i = 0; $i < 6; $i++) {
    if (preg_match('/^#[0-9A-Fa-f]{3,8}$/', $v)) return $v;
    $a = sds_alias($v);
    if ($a === null) return null;
    $v = (string)sds_get($css, $a);
  }
  return null;
}
function val_cell(string $css, string $v): string {
  $c = color_of($css, $v);
  return ($c ? '<i class="sw" style="background:' . sds_h($c) . '"></i>' : '') . '<code>' . sds_h($v) . '</code>';
}
function when(int $t): string { return date('j M H:i', $t); }

$flash = $_SESSION['flash'] ?? []; unset($_SESSION['flash']);
$newkey = $_SESSION['newkey'] ?? null; unset($_SESSION['newkey']);
$csrf = '<input type="hidden" name="csrf" value="' . sds_h($_SESSION['csrf']) . '">';
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>DS sync · Swing</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700;800&display=swap" rel="stylesheet">
<style>
:root{--ink:#1C1C28;--mut:#8F90A6;--line:#E4E4EB;--tile:#F5F5F7;--pri:#5C00E6;--ok:#05A660;--bad:#E53535}
*{box-sizing:border-box}body{margin:0;font:400 14px/20px Manrope,system-ui,sans-serif;color:var(--ink);background:#fff}
main{max-width:880px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:24px;line-height:30px;font-weight:800;margin:0 0 4px}h2{font-size:16px;line-height:22px;font-weight:800;margin:0}
.sub{color:var(--mut);margin:0 0 24px}section{border-top:1px solid var(--line);padding:24px 0}
.head{display:flex;align-items:center;gap:12px;margin-bottom:12px}.head .n{color:var(--mut);font-weight:700}.head .sp{margin-left:auto;display:flex;gap:8px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);font-weight:700;padding:8px;border-bottom:1px solid var(--line)}
td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:middle}td.m{color:var(--mut);font-size:12px}
code{font:500 12px/16px ui-monospace,Menlo,monospace}.sw{display:inline-block;width:14px;height:14px;border:1px solid rgba(0,0,0,.12);vertical-align:-2px;margin-right:6px}
.arr{color:var(--mut);padding:0 4px}.warn{color:var(--bad);font-size:12px;display:block}
.btn{font:700 13px/18px Manrope,sans-serif;height:36px;padding:0 16px;border:1px solid var(--line);background:#fff;color:var(--ink);cursor:pointer}
.btn.pri{background:var(--pri);border-color:var(--pri);color:#fff}.btn.link{border:0;padding:0;height:auto;color:var(--pri);background:none}
.msg{padding:10px 12px;margin:0 0 16px;background:var(--tile)}.msg.bad{color:var(--bad)}.msg.ok{color:var(--ok)}
.empty{color:var(--mut);margin:0}input[type=text],input[type=password]{font:inherit;height:36px;padding:0 12px;border:1px solid var(--line);min-width:220px}
.key{background:var(--tile);padding:12px;margin:12px 0}.key code{font-size:13px;user-select:all;word-break:break-all}
form.inl{display:inline}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
</style></head><body><main>
<h1>DS sync</h1>
<p class="sub">Token changes sent from the Figma plugin go straight into <code>tokens.css</code>, after a backup. Undo any update here.</p>
<?php foreach ($flash as $f): ?><p class="msg <?= sds_h($f[0]) ?>"><?= sds_h($f[1]) ?></p><?php endforeach; ?>

<?php if (!$owner): ?>
<section><form method="post" class="row"><input type="hidden" name="do" value="login">
<input type="password" name="password" placeholder="Owner password" autocomplete="current-password" autofocus required>
<button class="btn pri">Sign in</button></form></section>
<?php else:
  $hist = array_slice(sds_read_json('history.json', []), 0, 30);
  $keys = array_values(array_filter(sds_read_json('keys.json', []), function ($k) { return empty($k['revoked']); }));
?>
<section>
<div class="head"><h2>History</h2></div>
<?php if (!$hist): ?><p class="empty">No updates yet. They show up here after someone clicks Update in the plugin.</p>
<?php else: ?><table><tr><th>When</th><th>Change</th><th>By</th><th></th></tr>
<?php foreach ($hist as $h): ?>
<tr><td class="m"><?= when((int)$h['at']) ?></td><td>
<?php if ($h['action'] === 'restore'): ?>Undo: back to the version before <?= sds_h(preg_replace('/^tokens-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d).*$/', '$3/$2 $4:$5', $h['from'])) ?>
<?php else: foreach ($h['changes'] as $c): ?><div><code><?= sds_h($c['name']) ?></code> <?= val_cell($css, $c['old']) ?><span class="arr">→</span><?= val_cell($css, $c['new']) ?></div><?php endforeach; endif; ?></td>
<td class="m"><?= sds_h((string)($h['by'] ?? '')) ?><?= !empty($h['file']) ? '<br>' . sds_h($h['file']) : '' ?></td>
<td><?php if ($h['action'] !== 'restore' && !empty($h['backup'])): ?><form method="post" class="inl" onsubmit="return confirm('Put tokens.css back to how it was before this update? Later updates are undone too.')"><?= $csrf ?><input type="hidden" name="do" value="restore"><input type="hidden" name="backup" value="<?= sds_h($h['backup']) ?>"><button class="btn link">Undo</button></form><?php endif; ?></td></tr>
<?php endforeach; ?></table><?php endif; ?>
</section>

<section>
<div class="head"><h2>Access keys</h2><span class="n"><?= count($keys) ?></span></div>
<?php if ($newkey): ?><div class="key">Key for <b><?= sds_h($newkey[0]) ?></b>. Copy it now, it is not shown again:<br><code><?= sds_h($newkey[1]) ?></code></div><?php endif; ?>
<?php if ($keys): ?><table><tr><th>Name</th><th>Created</th><th></th></tr>
<?php foreach ($keys as $k): ?><tr><td><?= sds_h($k['name']) ?></td><td class="m"><?= when((int)$k['created']) ?></td>
<td><form method="post" class="inl" onsubmit="return confirm('Revoke this key?')"><?= $csrf ?><input type="hidden" name="do" value="revoke"><input type="hidden" name="id" value="<?= sds_h($k['id']) ?>"><button class="btn link">Revoke</button></form></td></tr><?php endforeach; ?></table><?php endif; ?>
<form method="post" class="row" style="margin-top:12px"><?= $csrf ?><input type="hidden" name="do" value="add-member">
<input type="text" name="name" placeholder="Name, e.g. Aaron" maxlength="40" required><button class="btn">Create key</button></form>
</section>

<section><form method="post"><?= $csrf ?><button class="btn link" name="do" value="logout">Sign out</button></form></section>
<?php endif; ?>
</main></body></html>
