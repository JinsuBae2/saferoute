# A01-3 서버 파일 입력 지연 개선

관련: [#84](https://github.com/JinsuBae2/saferoute/issues/84), 상위 [#9](https://github.com/JinsuBae2/saferoute/issues/9). 2026-11-09, 조대성 / Rinhaze.

**AV1 개발 원본 2개의 준비 형식을 FFV1에서 UTVideo 무손실 복사본으로 바꾸어, 같은 서버의 실제 worker 실행 두 번에서 연기 샘플 20/20 처리·건너뜀 0·STALE 0을 확인했다.** 모델·640/500ms/0.25·누적 창·최소 검출 횟수·worker·API·3000ms 유효기간은 변경하지 않았다. 원본 AV1의 OpenCV 직접 입력을 지원하게 만든 변경은 아니며, 아래 명시적 준비가 필요하다.

이전 실패는 [A01-2 기록](a01-server-validation.md)과 원본 증거에 보존한다. 이번 수치·파일 해시·환경·두 실행 결과는 [A01-3 실측 JSON](../../deploy/resource-checks/2026-11-09-ai-input-latency.json)에 있다. 성능 확인 범위는 이 개발 입력·장비의 짧은 파일 재생이다.

## 1. 원인 확인과 선택

이전 연기 worker는 292프레임을 디코딩하면서 20개 분석 기회 중 12개를 건너뛰었고, 마지막 관측→EOF 사이에 STALE가 발생했다. 실제 모델 없이 같은 FFV1 파일을 읽어 비교했다. 선택한 20개 샘플의 BGR 해시·media timestamp는 모든 방식에서 같았다.

| 읽기 방식 | 디코더 스레드 | 292프레임 읽기·선택 샘플 해시 시간 s |
| --- | ---: | ---: |
| 기존 read | 기본 4 | 7.955 |
| grab 후 선택 프레임만 retrieve | 기본 4 | 7.542 |
| grab/retrieve | 2 | 9.793 |
| grab/retrieve | 1 | 17.188 |
| 최종 UTVideo 복사본, 기존 read | 기본 설정 | 1.696 |

비샘플 프레임 변환 생략의 개선은 작았고, 디코더 스레드 감소는 더 느렸다. 입력 디코딩 비용을 줄이는 준비 형식을 선택했다. 시간에는 선택 샘플의 BGR 바이트 해시 계산도 포함되며, 각각 한 번의 진단이므로 통계적 코덱 벤치마크나 원인별 CPU 사용률 분석으로 표시하지 않는다. 실제 worker 전체의 개선 여부는 아래 두 번의 전송 시험으로 확인했다.

## 2. 원본·파생·코드의 대조

[새 준비 스크립트](../../deploy/resource-checks/a01-84-prepare.sh)는 canonical manifest의 연기 `dev-smoke-0009`와 통로 `dev-metro-ermita-corridor`만 libdav1d→UTVideo / yuv420p MKV로 변환한다. 원본 해시를 먼저 확인하고, 원본과 복사본의 **모든 디코딩 프레임 크기·framemd5 및 ms 시각**을 대조한 뒤 runtime manifest를 만든다. 292/367프레임이 일치했다. 프레임 삭제·크기 변경은 하지 않았고 오디오는 제외한다. 원본·출처·라이선스·development 구분을 유지하며, 원본 전용 read_validation을 파생 항목에 그대로 복사하지 않는다.

최종 준비와 측정은 `PYTHONOPTIMIZE=1`로 실제 수행했다. 불일치는 명시적 오류로 중단되며, 해시·픽셀·시각 불일치 및 올바른 파생 설명을 최적화된 코드에서 검사하는 기존 시험을 두 준비 스크립트에 적용했다. A01-2 FFV1 스크립트는 과거 재현용으로 보존했다.

- 실제 실행한 기존 runtime/검증 코드 기준: `8811a12fe825bac8554366a260a73356f0d6dbca`. 새 준비 파일만 별도로 추가했다.
- 최종 실행한 `deploy/resource-checks/a01-84-prepare.sh`의 Git blob LF SHA-256: `1f481529b4f62b005d58af8623d1fe354b9ac15eefc5ca4cacacc1e7ba95a9d9`. 이번 PR의 같은 파일과 대조했다.
- 실행한 `tools/validate_ai_delivery.py`의 Git blob LF SHA-256: `b82b5dfa7cef1a4b1db9d2a829b770300d01466a9500809647acd0a7014d434e`. 기존 develop의 수정된 만료 검사 도구를 그대로 사용했다.
- 같은 Ubuntu 24.04.5 / Python 3.12.3 / 4 CPU와 기존 core·AI lock, FFmpeg 6.1.1-3ubuntu5를 사용했다. 패키지·모델 해시·설정은 실측 JSON의 offline_trial에 있다. 새 패키지나 서비스는 설치하지 않았다.
- 최종 연기 입력의 선택 BGR 20프레임은 과거 FFV1 읽기 진단의 선택 프레임과 해시·시각·크기가 같았다. 6개 영상의 144샘플 및 FIRE/SMOKE 검출 프레임 수도 기존 offline 결과와 같았다. 검출 수 일치는 독립 정확도 검증이 아니다.

읽기 비용·BGR 대조·환경 집계는 Git 제외 일회성 진단 코드로 계산했고 원본 JSON을 보존했다. 이를 공개된 전송 CLI가 직접 출력하는 필드로 취급하지 않는다. 실측 JSON은 진단 원본·CLI summary·manifest·준비 파일 및 전체 증거 묶음의 해시를 제공한다. 두 번의 복사본 파일 해시는 컨테이너 메타데이터 등으로 달라질 수 있어 각 실행의 conversion 기록을 별도로 연결했다.

## 3. 실제 worker·controller 결과

같은 서버의 서로 다른 격리 checkout에서 정상·불꽃·연기를 각각 실행했다. 최종 실행은 6개 영상 offline 비교 뒤에 수행했다. 각 회차는 새 TWO_ROUTE v1 세션과 자체 loopback controller를 사용한다.

| 연기 비교 | 분석 샘플 | 지연 건너뜀 | SMOKE ALARM | CAM-A 만료 | 최대 관측 age+다음 간격 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| A01-2 FFV1 | 8 | 12 | 5 | 1 | 1879.43 (EOF 직전 만료는 이 값만으로 드러나지 않음) |
| UTVideo 1차 | 20 | 0 | 19 | 0 | 903.66 |
| UTVideo 최종 | 20 | 0 | 19 | 0 | 896.78 |

| 최종 영상 | 분석 / 건너뜀 | 수신 (EOF 포함) | ALARM | 최대 age+다음 간격 ms | 만료 |
| --- | ---: | ---: | --- | ---: | ---: |
| LED 촛불 | 18 / 0 | 19 | 없음 | 930.88 | 0 |
| 촛불·성냥 | 51 / 0 | 52 | FIRE 11 | 992.74 | 0 |
| 연기 UTVideo | 20 / 0 | 21 | SMOKE 19 | 896.78 | 0 |

각 회차 모두 **92개 payload 일치**, EOF→UNAVAILABLE, 경보 유지, 닫힌 로그 무결성, controller 종료를 통과했다. 유효기간 검사는 age와 gap을 따로 비교하는 과거 방식이 아니라 `age_i + gap_i < 3000` 및 실제 CAM-A expire 결정 0회를 확인한다. 관측 간격뿐 아니라 EOF 직전 만료도 거부하는 기존 검사다. 따라서 마지막 관측을 heartbeat로 연장하거나 EOF 시각을 앞당겨 실패를 숨기지 않았다.

## 4. 재현과 배포 인계

검토된 코드를 별도 Linux checkout에 준비하고 기존 모델·canonical manifest의 원본 6개와 core/AI lock 가상환경, FFmpeg(libdav1d·utvideo)·ffprobe·libgl1을 갖춘다. 원본 URL·사용 조건은 canonical manifest를 따른다.

```sh
bash deploy/resource-checks/a01-84-prepare.sh "$PWD"
.venv-ai/bin/python -m tools.validate_ai_model --manifest runs/server-video-preparation-utvideo/assets.server.json --output runs/a01-utvideo-offline --pace
.venv-ai/bin/python -m tools.validate_ai_delivery --manifest runs/server-video-preparation-utvideo/assets.server.json --output runs/a01-utvideo-delivery
```

준비와 결과 폴더는 새 경로여야 한다. 준비 폴더가 이미 있으면 새 checkout에서 실행하고 기존 증거를 지우거나 덮어쓰지 않는다. 실제 worker 단독 실행에는 runtime manifest에 기록된 UTVideo 파일 경로를 `--video`로 넘긴다. 다른 영상·코덱·장비에 자동 적용하거나 실패 시 자동 변환하지 않는다. WFI 연결은 별도 mapping/필수 관측 준비가 필요하다.

최종 복사본 크기는 연기 약 322.35 MiB, 통로 약 300.65 MiB로 이전 FFV1 약 224/209 MiB보다 크다. 디스크 여유·입력 준비 시간을 고려한다. 검증 앱 listener는 종료했고 기존 22·53 포트만 남았으며, 격리 환경·원본·과거 FFV1·새 복사본·증거는 보존했다. 로컬 원본 묶음은 `runs/a01-84-evidence/`에 있다.

## 5. 남은 범위

이 개발 입력의 명시적 UTVideo 준비 경로에서는 이전의 샘플 누락·EOF 전 만료가 두 번 모두 재발하지 않았다. **AV1 원본 직접 입력, 임의 파일, 장시간·동시 카메라·CPU 크레딧·외부 네트워크·WFI/화면/실제 단말은 검증하지 않았다.** 원본과 파생 장면은 모두 development이며 독립 평가에 옮기지 않는다. Tai Po 연기 미검출과 수증기 후보 검출 등 기존 모델 한계도 그대로다. #9 최종 후보 채택·팀 라이선스 결정, #8/#12/#30 독립 평가, #41 Bedrock은 별도로 남는다.
