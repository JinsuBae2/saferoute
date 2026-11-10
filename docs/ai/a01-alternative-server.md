# A01-5 새 후보의 실제 지원 서버 비교

관련 [#111](https://github.com/JinsuBae2/saferoute/issues/111), 상위 #9/#30. 2026-11-10, 조대성 / Rinhaze.

## 목적과 실행 경계

[A01-4 개발 비교](a01-alternative-models.md)에서 Tai Po 연기 검출과 촛불 연속성이 개선된 xiazh 후보를 실제 지원 서버에서 기존 rabahdev와 비교한다. **서버 실행·전송·샘플 처리 능력의 비교이며 최종 모델 채택이나 독립 정확도 합격 판정이 아니다.** 기본 모델·임계값·경보 창·정답·매칭 규칙은 변경하지 않는다.

실행 소스는 develop `4325317348e39cc3633df2bcc25f6a8d458113fe`다. 팀의 WFI v4·수동 화재·한글 표시 변경을 포함한 버전을 격리 디렉터리에 준비했다. 검증은 기존 `tools.validate_ai_delivery`의 **자체 loopback TWO_ROUTE v1 / CAM-A / Z-A**에서 수행하며 공용 WFI 세션·서비스·방화벽을 변경하지 않는다. 기존의 미커밋 연기 실험과 평가용 영상·정답을 개발에 사용하지 않았다.

사전 자원 확인에서 논리 CPU 4개, 사용 가능 메모리 약 14.74GiB, 디스크 여유 20.75GiB, load average 0/0/0, listener 22·53만 확인했다. 기존 서버 AI 가상환경을 재사용하고 새로운 시스템·Python 패키지는 설치하지 않았다. 별도 CPU 추론과 영상 전송은 겹치지 않게 순차 실행하고 nice 10으로 실행 우선순위를 낮췄다. 전체 배치는 1500초 제한 안에서 수행하며, 영상별 기존 worker 제한은 240초다.

## 입력·모델과 대조

Q01 개발 7개(총 177.690초, 정상 4개 137.320초, 장면군 5개)를 모두 사용한다. 각 모델/영상은 한 번씩 새 출력 폴더와 새 제어 세션으로 실행한다. 한 영상의 실패가 다음 영상의 시도를 생략하게 하지 않으며 실패와 미시도를 공개 근거에 남긴다.

- 기존 rabahdev: SHA256 `b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f`.
- 새 xiazh: SHA256 `a06febf257bff40cf5f3814e77f5120e2a80ab91d3ff3a84370caf6fdf832740`. 고정 출처·revision·게시자 조건은 A01-4를 따른다.
- 두 모델 모두 640 / 500ms / confidence 0.25 / window 1500ms / min_detections 2 / CPU 4스레드다. 기존 [기준 설정](../../configs/ai.example.json)과 [새 후보 설정](../../configs/ai.xiazh.development.json)의 값을 그대로 사용한다.
- Smoke 0009는 서버 AV1 입력 한계 때문에 [A01-3](a01-input-latency.md)의 기존 UTVideo 복사본을 재사용했다. 원본 SHA256 `ff900050f8c79f4bf163f3536526de0e25a7fb617bee8d2d02fc6a074c638ce6`, 파생 SHA256 `85550517eaa0f1f076f2894749f7aca6213672415831686b4d4e43add789c544`다. 기존 변환 기록과 파일 해시를 확인하고 **이번에도 전체 292프레임의 yuv420p 크기/framemd5 및 ms 시각을 원본과 다시 대조**했다. 새 변환·프레임 삭제·크기 변경은 없다.
- 나머지 6개는 Q01 원본 바이트 그대로이며 각 해시를 확인했다. 파생본도 동일한 development 장면이다. 파생 파일의 로그를 원본 파일 해시를 요구하는 GT에 넣지 않았으며, 이번 기록은 새 서버 TP/FP/FN을 주장하지 않는다. 검출 프레임 수·ALARM 메시지 수와 사건 정확도는 다르다.

## 판정과 재현

전송 검증의 PASS는 payload 일치·EOF→UNAVAILABLE·경보 유지·3초 관측 유효기간·닫힌 제어 로그를 확인한다. **샘플이 일부 건너뛰어져도 전송 검증은 PASS일 수 있으므로, 별도로 full_sampling_pass를 계산한다.** 같은 파일을 pacing 없이 읽은 benchmark의 예정 프레임 인덱스와 실제 분석·skip 기록을 대조하고, 모든 예정 샘플을 처리했을 때만 전체 샘플 처리를 통과로 표시한다.

검토된 소스를 별도 Linux checkout에 준비하고 기존 core/AI 환경·ffprobe·원본 영상 7개·검증한 UTVideo 파일·두 가중치를 갖춘다. 새 서버에서는 A01-3의 공개 준비 스크립트로 복사본을 만들고 그 실행의 변환 기록/해시를 사용한다. `runs/input.server.json`의 7개 항목은 원본 asset_id/split/scene_id를 유지하고, Smoke 0009에만 실제 파생 경로/해시와 server_derivation을 기록한다. `runs/baseline.json`·`runs/xiazh.json`은 위 공개 설정이며 가중치를 해당 상대 경로에 배치한다.

저장소 루트에서 각 모델과 각 asset_id에 대해 다음을 **순차로 한 번씩** 실행한다. 출력 폴더는 매번 새 경로여야 한다. 실패 반환 코드·summary·console을 보존한 뒤 다음 영상으로 넘어가며 성공 출력으로 덮어쓰지 않는다.

```sh
export PYTHONUTF8=1 PYTHONPATH=. YOLO_OFFLINE=true YOLO_AUTOINSTALL=false
nice -n 10 .venv-ai/bin/python -m tools.validate_ai_delivery --manifest runs/input.server.json --config runs/xiazh.json --asset-id dev-candle-match --output runs/server-trial/xiazh-dev-candle-match
nice -n 10 .venv-ai/bin/python deploy/resource-checks/a01-105-benchmark.py --manifest runs/input.server.json --config runs/xiazh.json --output runs/server-trial/xiazh-benchmark
```

대상은 dev-candle-match, dev-caviar-browse-whilewaiting2, dev-caviar-meet-walktogether1, dev-caviar-walk1, dev-flameless-candle, dev-joss-smoke, dev-smoke-0009다. baseline도 같은 전체 목록을 사용한다. 순수 predict는 합성 warm-up 뒤 별도 offline 실행으로 측정하며 전처리/추론/후처리를 포함하고 모델 로드·디코딩·재생 대기·API는 제외한다. 샘플 RSS는 관측 시점의 프로세스 RSS 최대이며 절대 peak를 보증하지 않는다.

실제 배치/준비용 일회성 스크립트와 원본 로그는 Git 제외 실행 증거에 보존하고 해시로 연결했다. 공개 CLI 자체가 출력하지 않는 전체 집계는 별도 읽기 전용 검사로 재계산한다. 서버 환경/소스/모델/입력/summary/예측/benchmark/제어 로그의 해시를 보존하며, 기록된 실행 버전과 이후 문서 머지 커밋을 혼동하지 않는다.

## 결과

실측·원본 로그의 해시와 재계산 결과는 [공개 JSON](../../deploy/resource-checks/2026-11-10-ai-alternative-server.json)에 있다. Ubuntu 24.04.5 / Python 3.12.3 / Xeon Platinum 8259CL / CPU 4개, torch 2.15.0+cpu·ultralytics 8.4.208·OpenCV 5.0.0.93·numpy 2.5.4·ffprobe 6.1.1-3ubuntu5에서 측정했다.

| 항목 | 기존 rabahdev | 새 xiazh |
|---|---:|---:|
| 전송 검증 PASS | 7/7 | 7/7 |
| 전체 샘플 처리 PASS | 7/7 | 7/7 |
| 분석 / 예정 샘플 | 358 / 358 | 358 / 358 |
| 늦은 샘플 폐기 / 관측 만료 | 0 / 0 | 0 / 0 |
| 수락 이벤트(EOF 포함) | 365 | 365 |
| 순수 predict 평균 / p95 / 최대 ms | 51.87 / 56.25 / 88.79 | 297.32 / 314.98 / 388.28 |
| 샘플링 프로세스 RSS 최대 MiB | 507.01 | 717.67 |
| 실제 획득→API 기록 최대 ms | 687.04 | 928.89 |

모델별 358개 전체 샘플을 처리했으며 합계 716개·수락 이벤트 730개다. 모든 14개 실행에서 실제 전송 payload 일치·EOF·닫힌 제어 로그·자체 controller 종료를 확인했다. 별도 offline benchmark도 모델별 358개 샘플을 측정했다. 새 후보의 평균 predict는 서버 기준 모델의 약 5.7배이며 샘플 RSS는 약 211MiB 늘었다. 최대 실제 획득→API 시간은 500ms보다 길 수 있으므로 **500ms 종단 지연을 보증하지 않는다.** 샘플 누락 없이 예정 프레임을 처리했고 3000ms 유효기간과 실제 만료 검사를 통과했다는 결과다.

| 개발 영상 | 각 모델 분석 샘플 | 기준 FIRE / SMOKE ALARM 메시지 | xiazh FIRE / SMOKE ALARM 메시지 |
|---|---:|---:|---:|
| 촛불·성냥 | 51 | 11 / 0 | 47 / 0 |
| CAVIAR browse | 152 | 0 / 0 | 0 / 0 |
| CAVIAR meet | 57 | 0 / 0 | 0 / 0 |
| CAVIAR walk | 49 | 0 / 0 | 0 / 0 |
| LED 촛불 | 18 | 0 / 0 | 0 / 0 |
| Tai Po 연기 | 11 | 0 / 0 | 0 / 2 |
| Smoke 0009 UTVideo | 20 | 0 / 19 | 0 / 19 |

xiazh는 서버에서도 Tai Po의 11개 샘플 중 4개에 연기 박스를 출력하고 2개 SMOKE ALARM을 전달했다. 정상 4개 영상에는 두 모델 모두 ALARM이 없었다. 다만 xiazh LED 영상의 2개 샘플에 SMOKE 박스가 있었으므로 **정상 프레임의 원시 검출까지 0인 것은 아니다.** 기존 min_detections 조건을 만족하지 않아 경보로 이어지지 않았다. offline 모델별·영상별 검출 프레임 수는 A01-4 Windows 결과와 같았지만 전체 박스 좌표/점수나 독립 정확도가 같다는 주장은 아니다.

최종 listener는 시작과 같은 22·53뿐이며 자체 검증 프로세스·제어기는 종료했다. 실행 디렉터리·모델·입력·로그는 재현을 위해 보존한다. 실패한 영상 실행/benchmark와 미시도 영상은 이번 고정 목록에서 없었다. 이 사실을 과거 A01-2의 AV1/STALE 실패가 없었던 것으로 바꾸지 않는다.

해시 표현도 구분했다. `server_metadata.source_sha256`은 아카이브로 전달해 **실제 실행한 원시 바이트(CRLF 포함)**의 SHA256이고, `normalized_source_sha256`은 로컬 코드 대조용 CRLF→LF 정규화 해시다. 원본 로그·manifest·summary·증거 묶음은 실제 바이트를 해시한다. 서버 소스는 전송 아카이브와 원시 해시가 같고, 줄바꿈을 정규화한 내용은 로컬 소스와 같음을 재검사했다.

## 남은 한계

개발용 짧은 파일 재생과 자체 loopback 검증이다. 장시간·동시 카메라·CPU 크레딧 소진·외부 네트워크·공용 WFI/브라우저/실제 단말·상시 배포는 검증하지 않는다. Windows 비교와는 장비·OS·Python/ffprobe·일부 입력 준비가 다르므로 속도 차이를 모델만의 원인으로 해석하지 않는다. 팀의 수치 목표·최종 모델/라이선스 합의와 담당 5의 독립 평가·중복 경보 개선은 별도로 남는다.
