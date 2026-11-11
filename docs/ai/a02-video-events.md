# A02 실제 영상 → 공통 이벤트 연결

담당 1번의 [#10](https://github.com/JinsuBae2/saferoute/issues/10) 로컬 개발 구현이다. 백엔드·계약·프론트 기능은 변경하지 않는다. A01 최종 선정은 대기 중이며, [A01 실행 기록](a01-model-validation.md)의 개발 후보를 사용한다. 서버 실행·프로젝트 라이선스 결정·독립 평가 완료를 뜻하지 않는다.

## 입력과 실행

Python 3.12 / Windows x86_64 CPU에서 검증했다. 별도 `.venv-ai`에 `requirements-core.lock.txt`와 `requirements-ai.lock.txt`를 함께 설치한다. AI lock은 A01의 동일 파일이며 다른 OS에서는 재검증해야 한다. 저장소 루트에서 실행한다.

```powershell
python -m pip install -r requirements-core.lock.txt -r requirements-ai.lock.txt
python -m ai_worker --config configs/ai.example.json --video data/videos/candle-and-match.ogv --controller http://127.0.0.1:8000
```

위 `python`은 활성화한 `.venv-ai`의 Python이다. 백엔드는 [README의 실행 절차](../../README.md#백엔드-실행)로 먼저 시작한다. 가중치·영상은 Git에 포함하지 않는다. 원본 위치·해시·사용 조건은 [A01 manifest](../../data/manifests/assets.json)에 기록되어 있다. 다운로드 전에 해당 사용 조건을 확인한다.

- 가중치: `models/fire-smoke-yolov8n.pt`, `rabahdev/fire-smoke-yolov8n` revision `13017fe8af477c25f5298d168e2dfede4b000753`.
- SHA-256: `b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f`. 불일치하면 로딩하지 않는다. 모델 클래스는 `0=smoke`, `1=fire`를 확인한다.
- 예제 매핑은 `TWO_ROUTE` v1, `CAM-A → Z-A`다. WFI 공간의 실제 카메라 배치는 별도 설정·검증한다.
- `configs/ai.example.json`을 `configs/ai.local.json`으로 복사해 환경별 값을 관리한다. local 파일은 Git에서 제외된다.
- `--runs-dir` 기본값은 저장소 `runs/`다. 백엔드와 별도 PC라면 실행 ID로 두 로그를 대조한다.

작업자는 새 session과 서버 건물 설정을 읽고 건물 버전·관측원 유형·구역·허용 클래스를 확인한다. 구역을 이벤트에 임의로 넣지 않고 서버의 source 매핑을 따른다. CAM-A를 이미 사용한 실행에는 붙지 않는다. 재실행 시 이전 작업자를 먼저 종료하고, 운영자가 의도한 run_id로 reset한 후 새 작업자를 시작한다. 작업자가 자동 reset·arm·경보 clear를 수행하지 않는다.

## 처리·기록 규칙

예제는 CPU `imgsz=640`, confidence `0.25`, 영상 위치 기준 `500ms` 샘플링, 최근 `1500ms` 창의 서로 다른 분석 프레임 `2개` 검출을 사용한다. 이 값은 개발용이며 A03에서 평가 전 고정할 정책과 구분한다. 현재 프레임에서도 해당 클래스가 검출되어야 ALARM을 만든다. 한 프레임의 여러 박스는 한 번만 세고, 클래스별로 독립 집계한다. confidence는 해당 프레임의 클래스별 최댓값이다. 두 클래스가 동시에 조건을 충족하면 서로 다른 이벤트 ID·순번으로 전송한다. 조건 미충족은 OBSERVATION이며 기존 경보를 해제하지 않는다.

영상 위치는 OpenCV `CAP_PROP_POS_MSEC`를 사용하며 FPS 메타데이터로 시각을 재구성하지 않는다. 영상 속도에 맞춰 진행하고, 처리 지연이 샘플 간격을 넘은 오래된 프레임은 건너뛰며 기록한다. 무한 추론 큐는 만들지 않는다.

- `media_time_ms`: 영상 안의 위치.
- `observed_at`: 읽기에 성공한 해당 프레임을 획득한 실제 UTC. 대기·추론·전송 후 현재 시각으로 바꾸지 않는다.
- `inference_completed_at`: 추론 완료 UTC. 대기 포함 획득→완료 monotonic 시간도 별도 기록한다.

`runs/<run_id>/ai-predictions.jsonl`은 새 파일로만 생성한다. 모델/영상 해시·설정·원시 박스·시각·이벤트·전송 시도·수신 응답·건너뜀·종료/실패를 기록한다. 출처는 `VIDEO_AI`이며 모의 센서나 설명 API 출력을 감지 결과로 만들지 않는다. 테스트의 가짜 모델은 자동검사 전용이며 실제 추론 증거와 구분한다.

전송은 예제에서 최대 2회, 요청별 timeout 750ms, 재시도 간격 100ms다. transport 오류·이벤트 POST 5xx에만 재시도하며 같은 직렬화 바이트·event_id·source_sequence·observed_at을 유지한다. 4xx·잘못된 계약 응답·다른 이벤트의 수신증은 실패다. 매 시도에 session을 재확인하고 run/건물 변경 시 멈춘다. 이미 신선도 기한을 넘은 관측은 재전송하지 않으며 최종 수락 여부는 서버가 검증한다. 실패는 로그와 비정상 종료로 드러난다.

A02 최초 구현은 읽기 종료를 `UNAVAILABLE/READ_ENDED_UNVERIFIED`로 표시했다. 현재의 EOF 근거·오류 처리·추가 ffprobe 실행 환경은 [A03-1 기록](a03-input-failures.md)을 따른다. 아래 A02 실행 수치는 최초 구현의 기록이며 새 동작으로 소급 변경하지 않는다.

## 실제 로컬 확인 — 2026-11-09

backend 기준 `a7813b9` 위의 A02 구현, Python 3.12.16, PyTorch 2.15.0+cpu, Ultralytics 8.4.208, OpenCV 5.0.0.93. 별도로 시작한 loopback HTTP 백엔드에 CLI의 실제 CPU 출력을 전송했다. 각 영상마다 독립 run을 사용하고 종료 상태 조회 후 운영자 reset으로 기록을 확정했다. AI 관측원 연결 검사이며 필수 가상 센서 arm·경로/단말 통합 시험은 포함하지 않는다.

| 개발 영상 | 분석 프레임 | 수신 이벤트 | ALARM | 획득→API 수신 최대 | API 수신 간격 최대 |
| --- | ---: | ---: | --- | ---: | ---: |
| flameless-candle.webm (LED 혼동 사례) | 18 | 19 | 없음 | 482.55ms | 524.41ms |
| candle-and-match.ogv | 51 | 52 | FIRE 11 | 516.27ms | 523.25ms |
| smoke-0009.webm | 20 | 21 | SMOKE 19 | 191.36ms | 514.28ms |

이벤트 수에는 각 종료 UNAVAILABLE 1건이 포함된다. 총 92개 이벤트의 전체 payload가 AI 전송 로그와 백엔드 수락 로그에서 일치했고, 분석 이벤트의 획득→수신 시간은 모두 CAM-A의 3000ms 미만이었다. 이 세 실행에서 늦은 프레임 건너뜀은 0개였다. FIRE·SMOKE 원인은 종료 UNAVAILABLE 뒤에도 남았고 정상 영상은 원인이 없었다. 경보 개수는 독립 사건 수나 정확도가 아니다.

로컬 원시 증거: `runs/a02-local-20261109T062915Z/summary.json`, `ai/<run_id>/ai-predictions.jsonl`, `backend/<run_id>/events.jsonl`, 영상별 `.state.json`/`.console.txt`. 아래 ID와 영상 해시로 대조한다. 원시 실행 자료는 Git에서 제외된다.

| 영상 | run_id | 영상 SHA-256 |
| --- | --- | --- |
| flameless-candle | eab23d88-cbcd-45e7-90ea-9c1a1584462d | a1d02d0ffbcbe4973586d0a2a11efdef544ba0cd678b7640daa8eaaa6a284f3a |
| candle-and-match | 26cd2345-29ee-493f-bcdc-081744c2db24 | 248be916e95fe7fa5155c94125d60abb3e611721f1f14de7629c2572eb99c3e5 |
| smoke-0009 | 295c1036-5bfb-4532-a8a4-75a625247c31 | ff900050f8c79f4bf163f3536526de0e25a7fb617bee8d2d02fc6a074c638ce6 |

자동검사: `python -m pytest tests/test_ai_worker.py -q`. 실제 백엔드와 가짜 시계/프레임/추론을 사용해 지속 조건, 중복 수신, reset, 제한 재시도, 오래된 관측, 구역 불일치, 영상 시각 역행, 지연 건너뜀, 종료 후 경보 유지를 확인한다. AI 패키지·가중치 다운로드 없이 공통 CI에서 실행된다.

## 남은 조건

- #9의 최종 모델 선정, 사용 조건·프로젝트 라이선스 결정, 지원 서버 검증은 아직 대기 중이다. A02는 개발 후보 연결 증거로 리뷰하며 이 선행 조건을 완료로 표시하지 않는다.
- A03: 영상 종료·오류 처리는 [A03-1](a03-input-failures.md)에서 진행한다. 개발 결과에 근거한 평가 조건·목표·영상 목록 고정은 #12에 남는다.
- A04/Q01: 독립 평가 영상·정답과 평가 집계. 현재 세 영상은 이미 개발에 사용했으므로 독립 평가 자료로 재사용하지 않는다.
- I02: 필수 가상 센서·경로·브라우저 단말과의 전체 통합 시험. 이번 작업은 로컬 AI→기존 API 연결이다.
