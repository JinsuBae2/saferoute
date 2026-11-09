# A03-1 영상 종료·장애 처리

담당 1번의 [#60](https://github.com/JinsuBae2/saferoute/issues/60). 상위 [#12](https://github.com/JinsuBae2/saferoute/issues/12)에서 영상 장애 구현을 분리했다. 평가 영상 목록·성능 목표 합의·평가 전 조건 고정은 #12에 남긴다. 해당 자료가 없는데 평가 준비 완료로 표시하거나, 완료된 장애 처리 코드의 통합을 함께 보류하지 않는다.

## 실행과 추가 환경

[A02 실행 방법](a02-video-events.md)을 사용하며 **ffprobe 실행 파일이 PATH에 있어야 한다.** FFmpeg 배포에 포함된 ffprobe를 사용한다. Windows에서는 설치 후 `ffprobe -version`, Ubuntu에서는 서버 담당자가 FFmpeg 설치와 같은 명령을 확인한다. Python lock과 별도인 시스템 실행 파일이다. 이번 로컬 검증 버전은 `N-124716-g054dffd133-20260531`이며 실행별 실제 버전을 로그에 기록한다. 다른 빌드·OS는 별도로 검증한다.

```sh
ffprobe -version
python -m ai_worker --config configs/ai.example.json --video data/videos/candle-and-match.ogv --controller http://127.0.0.1:8000
```

파일 재생 작업자이며 라이브 스트림 지원을 추가하지 않았다. 시작 시 ffprobe로 첫 영상 스트림을 끝까지 디코드해 프레임 수를 센다(`-count_frames`, `nb_read_frames`). FPS·컨테이너의 선언된 프레임 수는 EOF 근거로 쓰지 않는다. 오류 출력 또는 비정상 종료가 있으면 실패다. 사전 검사는 60초 제한이며 실행 파일 없음·timeout도 명시적으로 실패한다. 따라서 길거나 느린 파일은 이 제한에 걸릴 수 있고, 사전 검사 시간만큼 시작이 늦어진다. 이 시간을 영상 재생·추론 지연 측정에 섞지 않는다.

OpenCV가 읽기를 끝냈을 때 실제 읽은 프레임 수가 사전 디코드 수와 같고 분석 프레임이 존재해야 EOF다. 불일치·읽기 예외·열기 실패는 DECODE_FAILED로 처리한다. **이 검사는 두 디코더의 오류 없는 완료와 프레임 수 일치 확인이다.** 정상적으로 디코드되는 짧은 파일이 원본에서 편집·잘린 것인지까지 판별하지 않는다. 원본 동일성은 출처 manifest의 SHA-256 대조로 별도 확인해야 한다. 자동 가림 판별도 구현하지 않았다.

## 오류와 경보 유지

| 상황 | 이벤트·로그·종료 |
| --- | --- |
| 디코드 수 일치, 실제 분석 후 읽기 종료 | UNAVAILABLE / EOF, 성공 종료 0 |
| 파일 사전 디코드 오류·읽기 실패·프레임 수 불일치 | UNAVAILABLE / DECODE_FAILED, 오류 종료 1 |
| 정상 디코드됐지만 지연으로 모든 분석 프레임을 건너뜀 | UNAVAILABLE / NO_ANALYZED_FRAMES, 오류 종료 1 |
| ffprobe 없음·60초 timeout | UNAVAILABLE / VIDEO_PREFLIGHT_UNAVAILABLE, 오류 종료 1 |
| 영상 시각 역행·비정상 수치 | UNAVAILABLE / INVALID_MEDIA_TIME, 오류 종료 1 |
| 추론 예외·유효하지 않은 모델 출력 | UNAVAILABLE / INFERENCE_FAILED 또는 INVALID_DETECTION, 오류 종료 1 |
| 작업 중 Ctrl+C | 가능한 경우 UNAVAILABLE / OPERATOR_STOPPED, 종료 130 |
| 관측 전송 실패·이미 오래된 결과 | 같은 이벤트의 제한 재시도 또는 즉시 실패, 실패 로그, 종료 1 |

오류 알림도 기존 EventSender의 session 확인·동일 바이트 재시도·freshness 검사를 따른다. 알림 전달 실패는 `unavailable_delivery_failed`로 별도 기록하고 최초 오류를 보존한다. 일반 관측 전송 자체가 실패했으면 새 이벤트로 두 번째 전송 루프를 시작하지 않는다. 프로세스 강제 종료·통신 불가로 알림을 못 보낸 경우 서버의 기존 freshness 기한으로 관측이 만료된다.

어떤 종료·실패도 clear/reset을 호출하지 않는다. 기존 경보는 정상 미검출·EOF·UNAVAILABLE·STALE 후에도 남는다. 같은 run의 이미 사용한 관측원에 재시작하면 A02의 SOURCE_ALREADY_USED_RESET_REQUIRED로 거부하며 자동 reset하지 않는다.

작업자는 생존 확인을 새 OBSERVATION으로 합성하지 않는다. 별도 백그라운드 heartbeat 기능은 추가하지 않았다. VIDEO_AI HEARTBEAT를 계약대로 주입한 시험에서 마지막 분석 프레임의 freshness를 연장하지 않는지 확인했다. 지연 프레임은 기존 정책으로 건너뛰고, 오래된 결과의 observed_at을 전송 시각으로 바꾸지 않는다.

## 실제 파일·HTTP 확인 — 2026-11-09

backend 기준 `b5eacbc`, A02와 동일한 Windows CPU 모델·설정, 독립 loopback 서버에서 CLI를 실행했다. 원본 가중치·영상 해시는 [A02 기록](a02-video-events.md)의 동일 파일이며 개발 자료다.

| 입력 | 실제 읽기/분석 프레임 | 경보 | 수신 이벤트 | 마지막 reason / 종료 코드 |
| --- | --- | --- | ---: | --- |
| flameless-candle.webm | 217 / 18 | 없음 | 19 | EOF / 0 |
| candle-and-match.ogv | 761 / 51 | FIRE 11 | 52 | EOF / 0 |
| smoke-0009.webm | 292 / 20 | SMOKE 19 | 21 | EOF / 0 |
| 촛불 파일의 앞 4096바이트를 0으로 바꾼 별도 시험 복사본 | 0 / 0 | 없음 | 1 | DECODE_FAILED / 1 |

총 93개 전체 payload가 AI 전송과 백엔드 수락 로그에서 일치했다. EOF 뒤 관측원은 UNAVAILABLE이며 불꽃·연기 원인은 유지됐다. 손상 복사본은 **오류 주입 시험**으로 원본 영상·독립 평가·감지 정확도에 포함하지 않는다. 자동 가림 인식이나 모든 종류의 잘림 검출을 입증한 결과도 아니다.

원시 증거는 Git 제외 경로 `runs/a03-local-20261109T073748Z/`의 summary·영상별 state/console·ai/backend 로그다.

| 입력 | run_id |
| --- | --- |
| LED | 98430254-a1a2-44a6-a86a-104d66f30117 |
| 불꽃 | 3bcb94ba-7b16-4659-9ad6-ac268531c25e |
| 연기 | cff80bd1-f7f8-4eda-80f7-fcd727a6dc8e |
| 손상 주입 | dc4df83f-caa7-49bc-b12e-4c6e7d1bd58f |

자동검사는 `python -m pytest tests/test_ai_worker.py tests/test_ai_failures.py -q`로 실행한다. 가짜 추론·시계·프레임 및 명시적 오류 주입으로 읽기 수 불일치, read 예외, 추론 예외, Ctrl+C, 알림 전달 실패, 제한 재시도, 관측 만료, HEARTBEAT 비갱신, EOF 후 경보·우회 경로·명령 API 유지, 재시작 거부를 확인한다. CI에서는 실제 가중치·ffprobe를 설치하지 않고 실제 CLI 검증과 구분한다.

V10의 AI/제어 부분을 확인했으며 실제 관제 창 종료·두 브라우저 단말·지원 서버 통합은 I02/V10의 팀 검수로 남긴다. #9 최종 모델 선정과 #12 평가 조건 고정도 별도다.
