<?php
// CLI test for lib.php against a copy of tokens.css:  php test_lib.php path/to/tokens.css
declare(strict_types=1);
require __DIR__ . '/sync/lib.php';
$css = (string)file_get_contents($argv[1]);
$fail = 0;
function ok($c, $m) { global $fail; if (!$c) { $fail++; echo "FAIL $m\n"; } }

ok(sds_root_bounds($css) !== null, 'root block found');
ok(sds_get($css, '--purple-500') !== null, 'purple-500 read');
ok(sds_get($css, '--color-primary') === 'var(--purple-500)', 'alias read');
ok(sds_get($css, '--track-tight') === '-0.02em', 'em read: ' . var_export(sds_get($css, '--track-tight'), true));
ok(sds_get($css, '--nope-1') === null, 'missing is null');
ok(sds_get($css, '--type-desktop-b1s-track') === 'var(--track-body)', 'second decl on one line');
ok(sds_get($css, '--fw-bold') === '700', 'value before comment: ' . var_export(sds_get($css, '--fw-bold'), true));

$n = sds_set($css, '--fw-bold', '600');
ok($n !== null && sds_get($n, '--fw-bold') === '600', 'set fw-bold');
ok(strpos($n, '--fw-bold: 600;      /* Figma names this') !== false, 'comment kept');
ok(sds_get($n, '--fw-semibold') === 'var(--fw-bold)', 'neighbour untouched');
ok(strlen($n) === strlen($css), 'same length after 700 -> 600: ' . (strlen($n) - strlen($css)));

$p = sds_get($css, '--purple-500');
$n2 = sds_set($css, '--purple-500', '#5A3FF0');
ok(sds_get($n2, '--purple-500') === '#5A3FF0', 'set color');
ok(sds_get($n2, '--purple-400') === sds_get($css, '--purple-400'), 'purple-400 untouched');
$diff = 0; $a = explode("\n", $css); $b = explode("\n", $n2);
foreach ($a as $i => $l) if ($l !== $b[$i]) $diff++;
ok($diff === 1 && count($a) === count($b), 'exactly one line changed');

$n3 = sds_set($css, '--type-desktop-b1s-track', 'var(--track-wide)');
ok(sds_get($n3, '--type-desktop-b1s-track') === 'var(--track-wide)' && sds_get($n3, '--type-desktop-b1-track') === 'var(--track-body)', 'set second on line');
ok(sds_set($css, '--nope-1', '1px') === null, 'set missing is null');
// a declaration inside a comment must not match
$c2 = ":root {\n  /* --x-1: 4px; */\n  --x-1: 8px;\n}\n";
ok(sds_get($c2, '--x-1') === '8px', 'comment decl ignored');
ok(sds_get((string)sds_set($c2, '--x-1', '12px'), '--x-1') === '12px' && strpos((string)sds_set($c2, '--x-1', '12px'), '/* --x-1: 4px; */') !== false, 'comment decl kept on set');

foreach (['#5A3FF0', '#fff', '#5A3FF080', 'var(--purple-500)', '16px', '0', '-0.02em', '1.5rem', '50%', '700'] as $v) ok(sds_valid_value($v), "valid $v");
foreach (['', '-', 'px', 'red', '16px; color: red', 'var(--a);}', 'url(x)', '#12345', 'calc(1px + 2px)', '<b>'] as $v) ok(!sds_valid_value($v), "invalid $v");
foreach (['--purple-500', '--a'] as $v) ok(sds_valid_name($v), "name $v");
foreach (['purple', '--A', '--a b', '---'] as $v) ok(!sds_valid_name($v), "bad name $v");
ok(sds_member('sds_' . str_repeat('a', 40)) === null, 'unknown key');
ok(sds_member('nope') === null, 'malformed key');

echo $fail ? "$fail failed\n" : "all passed\n";
exit($fail ? 1 : 0);
