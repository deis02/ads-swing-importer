<?php
/* Swing DS sync: shared helpers for push.php (plugin -> draft) and index.php (review -> tokens.css).
   Lives at <docroot>/swing/ds/sync/. Keys, drafts, history and backups live OUTSIDE the docroot in
   ~/swing-ds-sync, so none of them can be fetched over the web. */
declare(strict_types=1);

function sds_data(): string { return dirname(__DIR__, 4) . '/swing-ds-sync'; }
function sds_tokens_path(): string { return dirname(__DIR__) . '/tokens.css'; }

function sds_read_json(string $file, $default) {
  $p = sds_data() . '/' . $file;
  if (!is_file($p)) return $default;
  $j = json_decode((string)file_get_contents($p), true);
  return is_array($j) ? $j : $default;
}

function sds_write_json(string $file, $data): void {
  $p = sds_data() . '/' . $file;
  $tmp = $p . '.tmp' . bin2hex(random_bytes(4));
  file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
  chmod($tmp, 0600);
  rename($tmp, $p);
}

/* One lock for every read-modify-write of the draft, history and tokens.css. */
function sds_lock() {
  $h = fopen(sds_data() . '/.lock', 'c');
  if (!$h || !flock($h, LOCK_EX)) throw new RuntimeException('Could not lock the sync data.');
  return $h;
}
function sds_unlock($h): void { flock($h, LOCK_UN); fclose($h); }

/* ---------- tokens.css ---------- */

/* [start, end) of the body of the first :root { ... } block. */
function sds_root_bounds(string $css): ?array {
  if (!preg_match('/(^|\})\s*:root\s*\{/m', $css, $m, PREG_OFFSET_CAPTURE)) return null;
  $start = $m[0][1] + strlen($m[0][0]);
  $depth = 1; $n = strlen($css); $inComment = false;
  for ($i = $start; $i < $n; $i++) {
    $two = substr($css, $i, 2);
    if (!$inComment && $two === '/*') { $inComment = true; $i++; continue; }
    if ($inComment) { if ($two === '*/') { $inComment = false; $i++; } continue; }
    $c = $css[$i];
    if ($c === '{') $depth++;
    elseif ($c === '}' && --$depth === 0) return [$start, $i];
  }
  return null;
}

function sds_decl_re(string $name): string {
  return '/(?<![\w-])' . preg_quote($name, '/') . '\s*:\s*([^;{}]*?)\s*;/';
}

/* Declarations inside comments must not count, so match on a copy with comments blanked out. */
function sds_blank_comments(string $s): string {
  return preg_replace_callback('#/\*.*?\*/#s', function ($m) { return str_repeat(' ', strlen($m[0])); }, $s);
}

/* The token's current value in :root, or null when it is not there. */
function sds_get(string $css, string $name): ?string {
  $b = sds_root_bounds($css);
  if (!$b) return null;
  $body = sds_blank_comments(substr($css, $b[0], $b[1] - $b[0]));
  return preg_match(sds_decl_re($name), $body, $m) ? trim($m[1]) : null;
}

/* tokens.css with one :root value replaced; the trailing comment on that line is kept. */
function sds_set(string $css, string $name, string $value): ?string {
  $b = sds_root_bounds($css);
  if (!$b) return null;
  $body = substr($css, $b[0], $b[1] - $b[0]);
  if (!preg_match(sds_decl_re($name), sds_blank_comments($body), $m, PREG_OFFSET_CAPTURE)) return null;
  $vs = $m[1][0] === '' ? $m[0][1] + strpos($m[0][0], ':') + 1 : $m[1][1];
  $ve = $m[1][1] + strlen($m[1][0]);
  if ($m[1][0] === '') $value = ' ' . $value;
  $body = substr($body, 0, $vs) . $value . substr($body, $ve);
  return substr($css, 0, $b[0]) . $body . substr($css, $b[1]);
}

function sds_valid_name(string $n): bool { return (bool)preg_match('/^--[a-z0-9][a-z0-9-]{0,80}$/', $n); }

/* Only plain values the plugin produces: hex, var(--token), or a number with px/rem/em/%. */
function sds_valid_value(string $v): bool {
  return (bool)preg_match('/^(#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{4}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8}|var\(--[a-z0-9][a-z0-9-]{0,80}\)|-?(\d{1,6}(\.\d{1,4})?|\.\d{1,4})(px|rem|em|%)?)$/', $v);
}

function sds_alias(string $v): ?string { return preg_match('/^var\((--[a-z0-9-]+)\)$/', $v, $m) ? $m[1] : null; }

/* ---------- keys ---------- */

function sds_key_hash(string $key): string { return hash('sha256', $key); }

/* The member for a bearer key, or null. */
function sds_member(string $key): ?array {
  if (!preg_match('/^sds_[0-9a-f]{40}$/', $key)) return null;
  $h = sds_key_hash($key);
  foreach (sds_read_json('keys.json', []) as $k) {
    if (empty($k['revoked']) && isset($k['hash']) && hash_equals($k['hash'], $h)) return $k;
  }
  return null;
}

function sds_h(string $s): string { return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }

/* ---------- writing tokens.css (callers hold sds_lock) ---------- */

function sds_history_add(array $e): void {
  $h = sds_read_json('history.json', []);
  array_unshift($h, $e + ['at' => time(), 'by' => 'owner']);
  sds_write_json('history.json', array_slice($h, 0, 300));
}
function sds_backup_tokens(string $css): string {
  $dir = sds_data() . '/backups';
  if (!is_dir($dir)) mkdir($dir, 0700, true);
  $f = 'tokens-' . date('Ymd-His') . '-' . bin2hex(random_bytes(2)) . '.css';
  file_put_contents($dir . '/' . $f, $css);
  chmod($dir . '/' . $f, 0600);
  return $f;
}
function sds_write_tokens(string $css): void {
  $p = sds_tokens_path(); $tmp = $p . '.tmp' . bin2hex(random_bytes(4));
  if (file_put_contents($tmp, $css) === false) throw new RuntimeException('Could not write tokens.css.');
  chmod($tmp, 0644);
  rename($tmp, $p);
}
