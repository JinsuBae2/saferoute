#!/bin/sh
# 끝난 개인 체험방의 실행 기록을 지운다. 살아 있는 방은 매 순간 기록하므로,
# 30분 동안 아무 파일도 바뀌지 않은 방 폴더만 끝난 것으로 본다.
ROOMS=/home/ubuntu/saferoute-runs/rooms
[ -d "$ROOMS" ] || exit 0
for d in "$ROOMS"/*/; do
  [ -d "$d" ] || continue
  if [ -z "$(find "$d" -type f -mmin -30 -print -quit)" ]; then
    rm -rf -- "$d" && echo "$(date -u +%FT%TZ) removed $(basename "$d")"
  fi
done
