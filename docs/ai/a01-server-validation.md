# A01-2 지원 서버 실제 추론·관측 전송 기록

관련: [#81](https://github.com/JinsuBae2/saferoute/issues/81), 상위 [A01 #9](https://github.com/JinsuBae2/saferoute/issues/9). 2026-11-09, 조대성 / Rinhaze.

**서버 CPU에서 개발 영상 6개를 실행했고, 정상·불꽃·연기 3개 실행의 payload 전송·EOF·로그 무결성은 확인했다. 그러나 연기 실행은 EOF 전에 CAM-A가 STALE로 만료되어 관측 유효성 연속 유지에 실패했다.** AV1 원본 2개는 직접 디코딩에 실패하여 검증한 FFV1 복사본을 사용했고, 연기 worker는 예정 샘플 20개 중 12개를 건너뛰었다. 최종 모델 채택·독립 정확도·전체 배포의 합격 판정이 아니다.

공개 수치·해시·원본/파생 대응은 [실측 JSON](../../deploy/resource-checks/2026-11-09-ai-server.json)에 있다. 기존 [Windows 비교 기록](a01-selection-and-server-check.md)은 당시 결과로 보존한다.

## 1. 실행 환경과 범위

- 기준 코드: `38bb83c9d572d947be61e6004b7168abca52b6b4`에 이번 PR의 [전송 검증 도구](../../tools/validate_ai_delivery.py)를 추가하여 실행했다. 실행 도구 SHA-256은 `706208fb2a7b360cb982ce0cb047e382245c2d1f191611547fe4ae53dd54e4f3`이다.
- Ubuntu 24.04.5 LTS, Python 3.12.3, Xeon Platinum 8259CL / 논리 CPU 4개, RAM 약 15.41 GiB, GPU 없음. t3.xlarge 자원 안내는 [D01](../../deploy/README.md)을 따른다.
- 별도 `.venv-ai`에 기존 core·AI lock을 함께 설치했고 `pip check`를 통과했다. torch 2.15.0+cpu, ultralytics 8.4.208, OpenCV 패키지 5.0.0.93이며 전체 주요 버전은 실측 JSON에 있다. 시스템 Python 패키지는 변경하지 않았다.
- 시스템 실행 의존성 `ffmpeg`·`libgl1`을 설치했다. ffprobe 6.1.1-3ubuntu5를 사용했다. 이 패키지와 격리한 실행 디렉터리·가상환경·증거는 재현을 위해 남겼다.
- 모델 SHA-256: `b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f`. 실제 클래스 `0: smoke`, `1: fire`, CPU 4스레드, 640 / 500ms / confidence 0.25. worker는 기존 1500ms 누적 창·최소 2회 검출 설정을 그대로 사용했다.
- 운영 서비스와 별도 디렉터리에서 실행했다. 검증 도구는 자신의 `127.0.0.1` 임시 포트와 TWO_ROUTE v1 fixture만 사용한다. 기존 서버 주소를 입력받거나 WFI 세션을 reset하지 않는다. 종료 뒤 검증 controller 정지와 앱 listener 없음(기존 22·53만 존재)을 확인했다.

## 2. AV1 실패와 명시적 개발 복사본

처음에는 canonical manifest의 원본 6개를 그대로 실행했다. `smoke-0009.webm`에서 OpenCV가 AV1의 첫 프레임을 읽지 못해 실행이 실패했다. 별도 첫 프레임 검사에서 `metro-ermita-corridor.webm`도 같은 실패를 확인했다. 원본 실행 전체가 성공했다고 집계하지 않는다.

[재현 스크립트](../../deploy/resource-checks/a01-81-prepare.sh)는 해당 2개만 FFmpeg libdav1d CPU 디코딩→FFV1 / yuv420p MKV로 변환한다. 원본은 보존하고, 변환 전 원본 SHA-256 및 변환 후 모든 디코딩 프레임의 크기·framemd5와 ms 단위 media timestamp를 대조한다. 연기 292프레임, 통로 367프레임이 각각 일치했다. 오디오는 사용하지 않는다. 손실 없음은 이 디코딩 픽셀 형식과 시각 대조의 범위다.

변환 경로·새 파일 해시는 `runs/server-video-preparation/assets.server.json`에만 기록한다. canonical manifest는 변경하지 않는다. 각 파생 파일의 출처·사용 조건은 원본 manifest 항목을 유지하며 `server_derivation`으로 변경 사실을 기록한다. **원본·파생본 모두 같은 development 장면**이므로 독립 평가에 재사용하지 않는다. 원본 해시를 기대하는 평가 정답에 파생 파일을 원본인 것처럼 연결하지 않는다. 다른 실행에서는 컨테이너 메타데이터 등으로 파일 해시가 달라질 수 있으므로 그 실행의 검증 결과·해시를 새로 보존한다.

Fable 검토 후 준비 스크립트의 `assert`를 명시적 오류 처리로 바꿔 Python 최적화 모드에서도 불일치를 거부하도록 했고, 파생 manifest에 남았던 원본 전용 `read_validation`을 제거하고 `transformation`을 정정했다. 최적화된 코드에서 해시·프레임·시각 불일치와 정상 메타데이터를 확인하는 회귀 테스트 4개를 추가했다. 같은 서버의 새 격리 checkout에서 `PYTHONOPTIMIZE=1`로 준비 절차를 실제 재실행하여 292/367프레임·시각 일치와 수정된 메타데이터를 확인했다. 실측 JSON의 `preparation_correction_recheck`가 별도 근거다. 최초 추론·전송 결과와 그때의 raw manifest는 당시 증거로 보존하므로, 원본 설명이 남았던 과거 manifest를 최신 재현 템플릿으로 사용하지 않는다. 아래 성능 수치는 최초 실측이며 준비 절차 재검증을 새로운 추론 측정으로 집계하지 않았다.

## 3. 6개 영상 CPU 재생 속도 측정

`tools.validate_ai_model --pace`는 늦어진 샘플을 폐기하지 않고 측정한다. 정상 원본 4개와 검증한 FFV1 복사본 2개에서 총 144샘플을 처리했다. 샘플 수와 FIRE/SMOKE 검출 프레임 수는 기존 Windows 640 결과와 모두 같았다.

| 영상 | 샘플 | FIRE / SMOKE | 평균 predict ms | 최대 완료 간격 ms | 최대 예정 시각 대비 지연 ms | 측정 최대 RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| LED 촛불 | 18 | 0 / 0 | 58.43 | 533.40 | 132.27 | 462.39 |
| 촛불·성냥 | 51 | 16 / 0 | 84.14 | 972.65 | 587.84 | 468.11 |
| Tai Po 연기 | 11 | 0 / 0 | 73.07 | 526.92 | 172.11 | 484.63 |
| Smoke 0009 (FFV1) | 20 | 0 / 20 | 96.02 | 545.31 | 208.20 | 494.39 |
| 실내 통로 (FFV1) | 25 | 0 / 0 | 77.65 | 553.10 | 206.46 | 496.51 |
| 수증기 후보 | 19 | 0 / 7 | 61.93 | 556.57 | 112.89 | 504.65 |

검출 프레임 수는 이벤트 수·정확도·재현율이 아니다. Tai Po 미검출과 수증기 후보의 연기 검출도 그대로 남는다. RSS는 측정 시점의 최대값이며 프로세스 생애 전체의 절대 peak는 아니다. 각 영상을 순차로 한 번 측정했으므로 지속 부하·동시 카메라·CPU 크레딧 소진·장시간 안정성은 검증하지 않았다. 완료 간격·재생 지연에는 디코딩과 대기 영향이 포함되며 모델 predict 시간과 구분한다.

## 4. 실제 worker→자체 controller 전송

`tools.validate_ai_delivery`는 실제 모델을 사용하는 `ai_worker`를 별도 프로세스로 실행한다. 각 영상의 새 세션에서 송신 event payload와 accepted 감사 로그를 대조하고, EOF 뒤 상태·누적 경보 유지·닫힌 run 로그 무결성을 검사한다. 정상 종료 여부만으로 PASS를 정하지 않는다.

| 영상 | 분석 / 지연으로 건너뜀 | 수신 이벤트 (EOF 포함) | ALARM 이벤트 | 최대 취득→감사 기록 ms | 최대 연속 관측 기록 간격 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| LED 촛불 | 18 / 0 | 19 | 없음 | 527.33 | 643.87 |
| 촛불·성냥 | 51 / 0 | 52 | FIRE 11 | 496.55 | 561.58 |
| Smoke 0009 (FFV1) | 8 / 12 | 9 | SMOKE 5 | 322.96 | 1681.49 |

총 80개 수신 이벤트의 payload가 송신 기록과 일치했다. 3개 모두 EOF→UNAVAILABLE, 기존 FIRE/SMOKE 원인 유지, `tools.verify_run` 통과, 검증 controller 종료를 확인했다. 실제 worker는 늦은 샘플을 건너뛰므로 앞 절의 offline 분석 수와 같지 않다. **연기 12/20(60%) 건너뜀은 남은 성능 한계**다. 이번 검증을 통과시키기 위해 샘플 정책·임계값·모델을 변경하지 않았다.

최초 도구는 CAM-A 유효기간 3000ms와 관측 age·연속 관측 기록 간격을 따로 비교해 PASS로 기록했다. 이 방식은 **도착 당시의 지연으로 이미 소모한 유효기간과 마지막 관측→EOF 사이의 만료를 놓칠 수 있어 불충분했다.** Fable 지적을 확인하여 현재 도구는 `age_i + gap_i < freshness_ms`와 제어 로그의 CAM-A `expire` 부재를 함께 검사한다. 해당 결함과 경계·만료 사례의 회귀 테스트 8개를 추가했다.

수정한 판정을 원본 서버 감사 로그에 적용한 결과는 실측 JSON의 `freshness_correction_recheck`다. 정상·불꽃은 만료 0회, 연기는 **만료 1회로 FAILED**다. 연기의 마지막 관측 취득→EOF 감사 기록은 약 3245.14ms였고, 실제 만료 결정부터 EOF 수신 기록까지 234.73ms였다. 연속 관측 사이 age+gap 최대 1879.43ms만 보면 이 마지막 공백이 드러나지 않는다. 따라서 원본 `delivery.status=PASS`는 당시 부족했던 검사 출력으로 보존하며, 최신 유효성 판정은 `delivery_freshness_assessment=FAILED`가 대체한다. payload 80개·EOF/UNAVAILABLE·경보 유지·로그 무결성 확인 자체는 유효하다. 재판정은 저장된 실제 로그에 대한 검사이며 새 모델 추론 실행으로 표시하지 않는다.

age는 같은 서버 UTC의 `recorded_at - observed_at`, 간격·만료→EOF는 서버 단조 시각으로 계산한다. 감사 기록까지의 시간이며 정확한 API 접수 순간이나 외부 네트워크 지연을 뜻하지 않는다. 모델 로딩·예열·preflight·첫 관측 이전·EOF 이후 공백은 별도이며, EOF 직전의 만료는 이번 실패에 포함한다. WFI 필수 감지기·arm·실제 단말·브라우저·경로 시연은 검증하지 않았다.

## 5. 재현

검토된 이 PR의 코드를 별도 서버 checkout에 준비하고 canonical manifest의 모델·개발 원본 6개를 동일 상대 경로에 확보한다. 호스트·PEM·원본·가중치는 Git에 넣지 않는다. 필요한 시스템 라이브러리는 서버 담당자와 동일 실행 환경으로 준비한다.

```sh
python3.12 -m venv .venv-ai
.venv-ai/bin/python -m pip install -r requirements-core.lock.txt -r requirements-ai.lock.txt
.venv-ai/bin/python -m pip check
bash deploy/resource-checks/a01-81-prepare.sh "$PWD"
.venv-ai/bin/python -m tools.validate_ai_model --manifest runs/server-video-preparation/assets.server.json --output runs/a01-server-compatible-paced-640 --pace
.venv-ai/bin/python -m tools.validate_ai_delivery --manifest runs/server-video-preparation/assets.server.json --output runs/a01-server-delivery
```

준비·측정 출력 경로는 새 디렉터리여야 한다. 기존 증거를 덮어쓰지 말고 재실행은 새 checkout 또는 새 측정 출력 경로를 사용한다. 본 실행의 원본 실패 로그, 환경, 성공 summary·JSONL·닫힌 제어 로그는 서버 격리 디렉터리와 로컬 `runs/a01-server-evidence/`에 보존했다. 공개 JSON은 선택한 원본 증거 파일들의 SHA-256을 제공한다. 비공개 원본 파일은 Git에 넣지 않았다.

## 6. 완료와 남은 판단

A01-2 #81의 서버 설치·실제 클래스/해시·개발 영상 CPU 실측·자체 API 전송·EOF/로그·종료 확인과 실패 근거 기록은 완료했다. #9 전체는 **AV1 입력·연기 처리 지연 및 EOF 전 STALE 한계 대응, 최종 후보 채택과 팀 프로젝트 라이선스 결정**이 남아 있다. 입력 호환성과 지연 개선은 별도 수정·재실측 없이 해결됐다고 표시하지 않는다.

Q01 #8 독립 자료·정답, A03 #12 평가 조건 고정, A04 #30 독립 평가, A05 #41 Bedrock 설명, D02/WFI 전체 배포는 각 담당 작업으로 남는다. 이번 실행은 Bedrock을 호출하지 않았다.
