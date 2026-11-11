<?php
/* One-time setup, CLI only:  php ~/swing-ds-sync-setup.php [--reset-password]
   Creates ~/swing-ds-sync (outside the docroot) and prints a new owner password once. */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$home = getenv('HOME') ?: dirname(__DIR__);
$dir = $home . '/swing-ds-sync';
if (!is_dir($dir)) mkdir($dir, 0700, true);
if (!is_dir($dir . '/backups')) mkdir($dir . '/backups', 0700, true);
chmod($dir, 0700);

foreach (['keys.json' => '[]', 'draft.json' => '{"changes":{}}', 'history.json' => '[]', 'login.json' => '[]'] as $f => $init) {
  if (!is_file("$dir/$f")) { file_put_contents("$dir/$f", $init); chmod("$dir/$f", 0600); }
}

$reset = in_array('--reset-password', $argv, true);
if (!is_file("$dir/admin.json") || $reset) {
  $alpha = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  $pw = '';
  for ($i = 0; $i < 18; $i++) $pw .= $alpha[random_int(0, strlen($alpha) - 1)];
  file_put_contents("$dir/admin.json", json_encode(['hash' => password_hash($pw, PASSWORD_DEFAULT), 'set' => time()]));
  chmod("$dir/admin.json", 0600);
  echo "OWNER_PASSWORD=$pw\n";
} else {
  echo "admin.json exists, password unchanged (use --reset-password to make a new one)\n";
}
echo "data dir ready: $dir\n";
