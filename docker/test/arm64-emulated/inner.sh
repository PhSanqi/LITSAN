#!/bin/sh
set -eu
# Refuse to touch binfmt unless we are in a fresh user namespace: its
# binfmt_misc instance is private, the host's is never mounted or written.
if grep -q 4294967295 /proc/self/uid_map; then echo "not in a new user namespace" >&2; exit 1; fi
mkdir -p /tmp/binfmt && mount -t binfmt_misc binfmt_misc /tmp/binfmt
# A sandboxed instance starts empty; any existing entry means it is shared.
if [ "$(ls /tmp/binfmt | grep -v -x -e register -e status | wc -l)" != 0 ]; then
  echo "binfmt_misc instance is not private; refusing to register" >&2; exit 1
fi
printf '%s' ':qemu-aarch64:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xb7\x00:\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/usr/bin/qemu-aarch64-static:F' > /tmp/binfmt/register
echo "private binfmt entries: $(ls /tmp/binfmt | tr '\n' ' ')"
R=/arm64root
mount -t proc proc $R/proc
mount --rbind /dev $R/dev
ENV=$(grep -v '^$' /work/image.env | tr '\n' ' ')
inroot() { chroot --userspec=1000:1000 $R /usr/bin/env -i $ENV "$@"; }
echo "uname -m in chroot: $(chroot $R /bin/uname -m)"
echo "node in chroot: $(inroot /usr/local/bin/node -p 'process.arch + " " + process.version')"
echo "file check: $(head -c 20 $R/opt/litsan/node_modules/better-sqlite3/build/Release/better_sqlite3.node | od -An -tx1 -j18 -N2)"
start=$(date +%s)
( cd $R && chroot --userspec=1000:1000 $R /usr/bin/env -i $ENV sh -c 'cd /opt/litsan && exec /opt/litsan/docker/entrypoint.sh' ) > /work/stack.log 2>&1 &
STACK=$!
ok=0
for i in $(seq 1 300); do
  if inroot /usr/local/bin/node /opt/litsan/docker/healthcheck.mjs >/dev/null 2>&1; then ok=1; break; fi
  kill -0 $STACK 2>/dev/null || break
  sleep 2
done
echo "image HEALTHCHECK (arm64 node in chroot) passed=$ok after $(( $(date +%s) - start ))s"
[ $ok = 1 ] || { tail -40 /work/stack.log; exit 1; }
bash /work/smoke.sh http://127.0.0.1:3001
H='-H content-type:application/json -H accept:application/json,text/event-stream -H mcp-protocol-version:2025-06-18'
EV=$(curl -fsS $H http://127.0.0.1:3001/mcp -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"litsan_turn","arguments":{"action":"record","origin":"user","user_text":"arm64 emulated smoke: Core write on aarch64.","assistant_text":"Noted."}}}' | sed -n 's/^data: //p' | node -e 'const r=JSON.parse(JSON.parse(require("fs").readFileSync(0,"utf8")).result.content[0].text); console.error("record ok="+r.ok+" ingested="+r.ingested); console.log(r.event_id)')
for i in $(seq 1 60); do grep -q '\[embedding\] Job succeeded' /work/stack.log && break; sleep 2; done
grep -E '\[embedding\] (Embedding request succeeded|Job succeeded)' /work/stack.log | tail -2 | sed 's/.*"message":"//; s/"}$//'
curl -fsS $H http://127.0.0.1:3001/mcp -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"litsan_memory\",\"arguments\":{\"action\":\"load\",\"evidence_ref\":\"l1:$EV\"}}}" | sed -n 's/^data: //p' | node -e 'console.log("load:", JSON.parse(JSON.parse(require("fs").readFileSync(0,"utf8")).result.content[0].text).item.content.split("\n")[0])'
kill -TERM $STACK; wait $STACK; echo "stack exit after SIGTERM: $?"
grep '\[litsan\]' /work/stack.log
