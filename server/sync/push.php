<?php
/* POST /swing/ds/sync/push.php  (from the Figma plugin)
   Authorization: Bearer sds_<key>
   { "file": "ADS TESTING", "changes": [ { "name": "--purple-500", "new": "#5A3FF0" }, ... ] }
   Writes the changes straight into tokens.css, after a backup. Each push is in History on index.php,
   where the owner can undo it. */
declare(strict_types=1);
require __DIR__ . '/lib.php';

// The plugin UI is an iframe with origin "null", so this endpoint answers any origin. It is guarded by the key.
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Max-Age: 600');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out(int $code, array $body): void { http_response_code($code); echo json_encode($body, JSON_UNESCAPED_SLASHES); exit; }

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['ok' => false, 'error' => 'Use POST.']);
if (!is_dir(sds_data())) out(503, ['ok' => false, 'error' => 'Sync is not set up on the server.']);

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
$key = preg_match('/^Bearer\s+(\S+)$/', $auth, $m) ? $m[1] : '';
$member = $key !== '' ? sds_member($key) : null;
if (!$member) { usleep(400000); out(401, ['ok' => false, 'error' => 'Access key not recognised. Ask the DS owner for a key.']); }

$raw = file_get_contents('php://input', false, null, 0, 131072);
$in = json_decode((string)$raw, true);
if (!is_array($in) || !isset($in['changes']) || !is_array($in['changes'])) out(400, ['ok' => false, 'error' => 'Expected { changes: [...] }.']);
if (count($in['changes']) > 400) out(400, ['ok' => false, 'error' => 'Too many changes in one push (max 400).']);
$file = mb_substr(trim((string)($in['file'] ?? '')), 0, 120);

$lock = sds_lock();
try {
  $orig = (string)file_get_contents(sds_tokens_path());
  $css = $orig; $done = []; $skipped = [];
  foreach ($in['changes'] as $c) {
    $name = is_array($c) ? (string)($c['name'] ?? '') : '';
    $new = is_array($c) ? trim((string)($c['new'] ?? '')) : '';
    if (!sds_valid_name($name)) { $skipped[] = ['name' => mb_substr($name, 0, 90), 'why' => 'Not a token name.']; continue; }
    $now = sds_get($css, $name);
    if ($now === null) { $skipped[] = ['name' => $name, 'why' => 'Not in :root of tokens.css.']; continue; }
    if (!sds_valid_value($new)) { $skipped[] = ['name' => $name, 'why' => 'Value not allowed: ' . mb_substr($new, 0, 60)]; continue; }
    $al = sds_alias($new);
    if ($al !== null && ($al === $name || sds_get($css, $al) === null)) { $skipped[] = ['name' => $name, 'why' => 'Points to ' . $al . ', which is not a token.']; continue; }
    if ($now === $new) { $skipped[] = ['name' => $name, 'why' => 'Already this value on the web.']; continue; }
    $next = sds_set($css, $name, $new);
    if ($next === null) { $skipped[] = ['name' => $name, 'why' => 'Could not write this token.']; continue; }
    $css = $next;
    $done[] = ['name' => $name, 'old' => $now, 'new' => $new];
  }
  if ($done) {
    $bak = sds_backup_tokens($orig);
    sds_write_tokens($css);
    sds_history_add(['action' => 'update', 'changes' => $done, 'backup' => $bak, 'by' => (string)$member['name'], 'file' => $file]);
  }
} catch (Throwable $e) {
  out(500, ['ok' => false, 'error' => 'Not saved: ' . $e->getMessage()]);
} finally { sds_unlock($lock); }

$https = 'https://' . ($_SERVER['HTTP_HOST'] ?? 'stat.chara.id');
out(200, ['ok' => true, 'updated' => array_column($done, 'name'), 'skipped' => $skipped,
  'history' => $https . dirname($_SERVER['SCRIPT_NAME']) . '/']);
