#!/bin/bash
# End-to-end test of push.php + index.php on an isolated copy (run on the chara server):
#   bash ~/sds-e2e.sh
# Layout mirrors the live one so sds_data() resolves to the test dir:  ~/sds-t/h/a/ds/sync -> ~/sds-t/swing-ds-sync
set -u
T=~/sds-t; D=$T/h/a/ds; PORT=18731; fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
mkdir -p $D/sync
cp ~/stat.chara.id/swing/ds/sync/lib.php ~/stat.chara.id/swing/ds/sync/push.php ~/stat.chara.id/swing/ds/sync/index.php $D/sync/
cp ~/stat.chara.id/swing/ds/tokens.css $D/tokens.css
HOME=$T php ~/swing-ds-sync-setup.php >/dev/null
KEY=$(HOME=$T php ~/sds-test-key.php add)

timeout 25 php -S 127.0.0.1:$PORT -t $T/h >/dev/null 2>&1 &
sleep 1
U=http://127.0.0.1:$PORT/a/ds/sync
BEFORE=$(md5sum < $D/tokens.css)

R=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"changes":[]}' $U/push.php)
check "no key -> 401 message" '[[ "$R" == *"not recognised"* ]]'

R=$(curl -s -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" \
  -d '{"file":"e2e","changes":[{"name":"--purple-500","new":"#5A3FF0"},{"name":"--space-16","new":"20px"},{"name":"--dark-400","new":"red"},{"name":"--color-primary","new":"var(--nope-9)"}]}' $U/push.php)
echo "  $R"
check "two tokens updated" '[[ "$R" == *"\"updated\":[\"--purple-500\",\"--space-16\"]"* ]]'
check "bad value skipped" '[[ "$R" == *"Value not allowed: red"* ]]'
check "bad alias skipped" '[[ "$R" == *"--nope-9, which is not a token"* ]]'
check "tokens.css has the new purple" 'grep -q -- "--purple-500: #5A3FF0;" $D/tokens.css'
check "tokens.css has the new space" 'grep -q -- "--space-16: 20px;" $D/tokens.css'
check "dark-400 untouched" '[ "$(grep -c -- "--dark-400: red" $D/tokens.css)" = 0 ]'
check "only 2 lines differ" '[ "$(diff ~/stat.chara.id/swing/ds/tokens.css $D/tokens.css | grep -c "^>")" = 2 ]'
check "backup = the old file" '[ "$(md5sum < $(ls $T/swing-ds-sync/backups/*.css | head -1))" = "$BEFORE" ]'
check "history entry by the key owner" 'grep -q "deploy smoke test" $T/swing-ds-sync/history.json && grep -q "\"update\"" $T/swing-ds-sync/history.json'
check "tokens.css is world-readable" '[ "$(stat -c %a $D/tokens.css)" = 644 ]'

R=$(curl -s -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" \
  -d '{"changes":[{"name":"--space-16","new":"20px"}]}' $U/push.php)
check "same value again -> nothing updated" '[[ "$R" == *"\"updated\":[]"* && "$R" == *"Already this value"* ]]'
check "no-op push makes no backup" '[ "$(ls $T/swing-ds-sync/backups | wc -l)" = 1 ]'

# owner page: log in, undo the update
PW=$(HOME=$T php ~/swing-ds-sync-setup.php --reset-password | sed -n 's/^OWNER_PASSWORD=//p')
J=$T/jar
curl -s -c $J -b $J -o /dev/null $U/
curl -s -c $J -b $J -o /dev/null -d "do=login&password=$PW" $U/
P=$(curl -s -c $J -b $J $U/)
check "owner sees history with Undo" '[[ "$P" == *"--purple-500"* && "$P" == *">Undo<"* ]]'
CSRF=$(echo "$P" | grep -o 'name="csrf" value="[0-9a-f]*"' | head -1 | sed 's/.*value="//;s/"//')
BAK=$(echo "$P" | grep -o 'name="backup" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
curl -s -c $J -b $J -o /dev/null -d "csrf=$CSRF&do=restore&backup=$BAK" $U/
check "undo puts tokens.css back exactly" '[ "$(md5sum < $D/tokens.css)" = "$BEFORE" ]'
curl -s -c $J -b $J -o /dev/null -d "csrf=bad&do=restore&backup=$BAK" $U/
check "bad csrf rejected" '[ "$(grep -c restore $T/swing-ds-sync/history.json)" = 1 ]'

echo "LIVE untouched: $( [ "$(md5sum < ~/stat.chara.id/swing/ds/tokens.css)" = "$BEFORE" ] && echo yes || echo NO)"
find $T -type f -delete; find $T -depth -type d -empty -delete
echo "cleaned: $( [ -e $T ] && echo NO || echo yes)"
[ $fails = 0 ] && echo "all passed" || echo "$fails failed"
