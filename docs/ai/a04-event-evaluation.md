# A04-1 단일 영상 사건 집계

관련: [#76](https://github.com/JinsuBae2/saferoute/issues/76), 상위 [A04 #30](https://github.com/JinsuBae2/saferoute/issues/30), [평가 계획 6절](../06-ai-development-evaluation-plan.md#6-평가-방법).

완료된 VIDEO_AI 실행 하나와 해당 영상 전체의 정답 JSON을 연결해 FIRE·SMOKE 사건을 집계한다. 출력의 `scope`는 `SINGLE_VIDEO_EVENT_METRICS`, `performance_verdict`는 항상 `NOT_ASSESSED`다. 이 도구의 구현·형식 시험은 독립 영상 평가 완료나 목표 통과를 의미하지 않는다.

## 실행

저장소의 core Python 환경에서 실행할 수 있다. 집계 자체에는 모델·PyTorch가 필요 없다.

```sh
python -m tools.evaluate_ai --predictions runs/AI_RUN/ai-predictions.jsonl --ground-truth data/expected/ai/evaluation.json --output runs/AI_RUN/ai-evaluation.json
python -m pytest tests/test_ai_evaluation.py -q
```

AI_RUN은 실제 실행 경로로 바꾼다. 입력·출력 디렉터리는 미리 존재해야 하며, 기존 출력 파일은 덮어쓰지 않는다. 성공 0, 잘못된 자료·실패한 실행·파일 오류 1, CLI 인자 오류 2를 반환한다. 오류가 난 실행을 정상 평가 결과에서 조용히 제외하지 말고 A04 실패 목록에 영상·run_id·오류를 남긴다.

start부터 verified EOF finished까지의 단일 실행만 받는다. 영상 해시, VIDEO_AI 출처, run/source/건물 식별자, 프레임 시각, 이벤트 순번·전송 payload·수락 응답, preflight/종료 건수를 대조한다. 실패·중단·섞인 실행·불완전 로그는 거부한다. 전송 재시도는 새로운 예측 사건으로 세지 않는다. SIM·수동 이벤트·Bedrock 설명은 입력 대상이 아니다. 이전 A02의 `READ_ENDED_UNVERIFIED` 로그는 재실행이 필요하다.

입력 정합성 검사와 해시는 자료의 진위나 주석의 독립성을 인증하지 않는다. 영상 파일 자체를 다시 읽지 않으므로 실제 파일의 SHA-256과 출처는 5번의 manifest와 별도 대조한다. 제어기 로그 무결성은 종료 후 `python -m tools.verify_run runs/RUN_ID`로 따로 검사한다.

## 5번에게 인계할 정답 형식

[evaluation.example.json](../../data/expected/ai/evaluation.example.json)은 **실제 영상·독립 정답이 없는 형식 예제**다. 0으로 채운 해시와 FORMAT_ONLY 항목을 실제 자료로 채우지 않으면 평가에 사용할 수 없다. 영상 하나당 정답 파일 하나를 만든다.

| 필드 | 의미 |
| --- | --- |
| schema_version | 1 |
| asset_id / scene_id | manifest의 영상·원본 촬영 장면 식별자. 인접 구간을 개발/평가로 나누지 않는다. |
| video_sha256 / source | 실제 영상 SHA-256 소문자 64자리 / 원본 출처. 사용 조건은 manifest에서 관리한다. |
| split | development, evaluation, fixture 중 하나 |
| annotator / reviewer | 주석자·검토자 기록명. evaluation은 reviewer 필수 |
| annotation_complete | 전체 영상을 검토하고 모든 FIRE·SMOKE 구간을 주석했을 때만 true |
| training_overlap | excluded, unknown, known. 모델 학습 자료와 중복 확인 결과 |
| development_used | 개발·조건 조정에 사용했다면 true. evaluation에는 false만 허용 |
| duration_ms | 전체 영상 길이, 양의 정수 ms |
| normal_video | 두 클래스 모두 전체 영상에서 없다고 주석한 경우 true, events는 빈 배열 |
| events | event_id(파일 내 고유), hazard_type(FIRE/SMOKE), start_ms, end_ms |

정답 구간은 `[start_ms, end_ms)`이며 `0 <= start < end <= duration`이다. 같은 클래스는 겹치면 안 된다. FIRE·SMOKE는 서로 겹칠 수 있다. 주석되지 않은 구간에 누락된 위험이 없는지 먼저 검토한다. 부분 주석을 전체 정상으로 해석하지 않는다. evaluation에서 알려진 학습 중복·개발 사용·검토자 누락은 거부하며, `unknown` 학습 중복은 그대로 보고한다. 선언만으로 독립성이 입증되는 것은 아니다.

## 계산과 한계

- 같은 클래스 ALARM의 직전 ALARM과 간격이 **1,000ms 이하**이면 한 예측 사건이다. OBSERVATION과 전송 재시도는 사건 수를 늘리지 않는다.
- 예측 사건 시작이 같은 클래스 정답의 반개방 구간 안에 있으면 아직 대응되지 않은 정답과 일대일로 연결한다. 허용 오차는 0ms다. 정답 이전에 시작해 정답까지 이어진 예측은 시작 시각 규칙상 FP이며 해당 정답은 다른 대응이 없으면 FN이다.
- 같은 정답 안에서 두 번째로 시작한 별개 예측은 FP다. 예측별 event_id·대응 정답 ID와 미검출 정답을 출력해 사람이 대조할 수 있다.
- precision은 TP/(TP+FP), recall은 TP/(TP+FN). 분모 0이면 `value: null`과 실제 numerator/denominator를 기록한다.
- `latency_ms`는 **영상 시각 기준** 예측 사건 시작−정답 시작이다. 대응 사건의 수·개별 값·평균·최댓값과 FN을 함께 보고한다. 실제 API 수신까지의 벽시계 지연이나 순수 추론 시간은 아니다.
- 정상 영상 오탐은 전체 영상이 정상으로 주석된 경우에만 FP 사건 수/전체 길이로 시간당 값을 계산한다. 위험 영상에는 해당 지표의 FP·길이·시간당 값을 모두 null로 기록한다. 위험 영상 안의 부분 정상 구간까지 분모로 확장하지 않는다.
- 새 worker 로그는 장비·Python/패키지 버전과 monotonic 기준 `processing_elapsed_ms`를 남긴다. `video_loop_frames_per_second`는 분석 프레임 수/루프 실소요시간이다. 재생 대기·프레임 읽기·추론·전송·로그·EOF 처리가 포함되며 모델 로딩·사전 전체 디코드는 제외된다. 모델 단독 벤치마크 FPS와 비교하지 않는다.
- `max_read_to_completion_ms`는 프레임 읽기 **직후**부터 추론·이벤트 준비 후까지의 최댓값이다. 재생 속도를 맞추는 대기가 포함되므로 순수 추론 처리시간이 아니며 프레임 디코드 시간·API 전송 시간은 포함하지 않는다. 구형 로그에 runtime/elapsed가 없거나 설치 배포명의 버전 메타데이터를 조회할 수 없으면 해당 값을 null로 표시하며 추정값을 채우지 않는다. 부가적인 패키지 버전 조회 실패가 실행 가능한 추론을 중단시키지는 않는다.

보고서에는 입력 두 파일의 해시, 영상·모델 해시, 설정, 실행·장면 ID, 주석 선언, runtime을 보존한다. 영상별 비율의 단순 평균을 전체 성능으로 사용하지 않는다. 전체 자료 집계·실패 목록·목표 비교·5번 독립 대조는 상위 A04에 남는다. 사건 정답으로 mAP를 계산하거나 미측정 정확도·현장 일반화를 주장하지 않는다.

## 구현 검증 근거 — 2026-11-09

수계산 fixture의 FIRE 정답 두 사건과 예측 두 사건은 TP=1, FP=1, FN=1, precision=recall=0.5다. SMOKE는 TP=1, FP=FN=0이다. 두 클래스의 대응 사건 지연은 각각 100ms다. 테스트는 정확히 1초 간격, 종료 경계, 중복 대응, 미검출·분모 0, 동시 클래스, 정상 영상 오탐, 재전송, 해시/시각/순번/수락 응답 변조와 실패 입력을 확인한다.

실제 개발용 LED 촛불 영상과 실제 모델로 만든 로그에도 도구를 실행했다. 정답은 **형식 확인용 fixture로 직접 작성했으며 독립 정답이 아니다**.

| 항목 | 결과 |
| --- | --- |
| run_id | 0798f2f8-f61a-40ba-9566-d4c643f97f92 |
| 영상 SHA-256 | a1d02d0ffbcbe4973586d0a2a11efdef544ba0cd678b7640daa8eaaa6a284f3a |
| 모델 SHA-256 | b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f |
| 설정 | configs/ai.example.json과 동일한 개발 후보 조건, CPU·torch 4 threads |
| 환경 | Windows 10, Python 3.12.16, torch 2.15.0+cpu, torchvision 0.29.2+cpu, ultralytics 8.4.208, OpenCV 5.0.0.93, numpy 2.5.4 |
| 프레임·수락 | 디코드 217, 분석 18, 지연 skip 0, 수락 19(EOF 포함), 전송·서버 payload 일치 |
| 루프 소요·처리량 | 8578ms, 약 2.098 분석 프레임/초. 순수 모델 FPS 아님 |
| 판정 | CLI 0, dataset_split=fixture, performance_verdict=NOT_ASSESSED, 제어 로그 무결성 PASS |
| 로컬 근거 | runs/a04-format-20261109T090045Z/summary.json, fixture-evaluation.json, ai/<run_id>/ai-predictions.jsonl (Git 제외) |

독립 평가 영상·정답은 Q01 #8, 모델·설정·매칭 규칙·목표 고정은 A03 #12, 실제 평가와 실패 분석은 A04 #30에서 이어간다. 이 기록의 fixture 수치를 독립 감지 성능으로 제출하지 않는다.
