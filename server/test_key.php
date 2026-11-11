<?php
// CLI only: php test_key.php add|remove  -- a throwaway key for the deploy smoke test
declare(strict_types=1);
if (PHP_SAPI !== 'cli') exit;
$f = (getenv('HOME') ?: '') . '/swing-ds-sync/keys.json';
$keys = json_decode((string)file_get_contents($f), true) ?: [];
$keys = array_values(array_filter($keys, function ($k) { return $k['name'] !== 'deploy smoke test'; }));
if (($argv[1] ?? '') === 'add') {
  $key = 'sds_' . bin2hex(random_bytes(20));
  $keys[] = ['id' => 'smoke', 'name' => 'deploy smoke test', 'hash' => hash('sha256', $key), 'created' => time()];
  echo $key . "\n";
}
file_put_contents($f, json_encode($keys, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
