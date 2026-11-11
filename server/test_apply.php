<?php
// CLI round-trip test:  php test_apply.php tokens.css changes.json out.css
// Applies the plugin's changes with the same checks push.php and index.php use.
declare(strict_types=1);
require __DIR__ . '/sync/lib.php';
$css = (string)file_get_contents($argv[1]);
$in = json_decode((string)file_get_contents($argv[2]), true);
$bad = 0;
foreach ($in['changes'] as $c) {
  $n = $c['name']; $v = $c['new'];
  if (!sds_valid_name($n) || !sds_valid_value($v) || sds_get($css, $n) === null) { echo "REJECTED $n = $v\n"; $bad++; continue; }
  $al = sds_alias($v);
  if ($al !== null && sds_get($css, $al) === null) { echo "BAD ALIAS $n = $v\n"; $bad++; continue; }
  $next = sds_set($css, $n, $v);
  if ($next === null || sds_get($next, $n) !== $v) { echo "NOT SET $n\n"; $bad++; continue; }
  $css = $next;
}
file_put_contents($argv[3], $css);
echo $bad ? "$bad problems\n" : 'applied ' . count($in['changes']) . "\n";
exit($bad ? 1 : 0);
