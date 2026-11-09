# A04-2 미리보기 실행 평가 호환·개발 정답 대조

담당 1의 [#96](https://github.com/JinsuBae2/saferoute/issues/96). [#93](https://github.com/JinsuBae2/saferoute/issues/93)의 개발 정답을 [A06 actual04](a06-preview-delivery.md)의 기존 실제 추론 로그 3건에 적용했다. **개발용 7개 중 3개에 대한 사건 집계이며 독립 평가·성능 합격·최종 모델 채택이 아니다.** 기록 시점의 develop은 `6f2d71e522962e2fd9fca877504b2f623397a7c2`다.

## 수정한 연결 오류

미리보기를 켠 AI 실행은 `finished` 뒤에 `preview_finished` 또는 종료 중 `preview_unavailable`을 기록한다. 기존 평가기는 마지막 줄이 `finished`인 로그만 허용해 정상 EOF 실행도 거부했다.

평가기에서 알려진 두 미리보기 보조 기록만 사건 계산에서 제외한다. 제외하기 전에 VIDEO_AI·실행/관측원 ID·UTC와 오류 형식/비음수 정수 카운트를 검사한다. `preview_finished`는 완료된 AI 실행 뒤의 마지막 줄이어야 한다. 전체 원본 로그의 SHA256은 보조 기록을 포함해 보존한다. 원본을 잘라내거나 재작성하지 않았다.

`failed`·미완료 실행·알 수 없는 기록·finished 뒤의 추가 AI 작업·누락 ACK·EOF 불일치 거부는 유지한다. 미리보기 실패가 AI 사건 점수를 바꾸지는 않으며, 이 평가는 JPEG 전송 성공을 판정하지 않는다. 미리보기 전달 검증은 A06 기록을 사용한다.

## 입력과 결과

[공개 근거 JSON](../../deploy/resource-checks/2026-11-10-ai-development-evaluation.json)에 영상·가중치·정답·원본 로그·산출 보고서 해시, 실행 ID, 설정, runtime, 사건 매칭과 처리 수치를 기록했다. 가중치는 `rabahdev/fire-smoke-yolov8n`, SHA256 `b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f`다. 640 / 500ms / confidence 0.25 / window 1500ms / min_detections 2인 기존 개발 후보 설정이다. 이번에는 추론을 재실행하거나 임계값을 변경하지 않았다.

| 개발 영상 | 길이 | 분석 샘플 | 평가할 사건 | TP / FP / FN | 사건 정밀도 / 재현율 | 첫 일치 지연 |
|---|---:|---:|---|---|---|---:|
| dev-flameless-candle | 8.680초 | 18 | 정상 | 두 클래스 각각 0 / 0 / 0 | 분모 0, null / null | 없음 |
| dev-candle-match | 25.470초 | 51 | FIRE | 1 / 4 / 0 | 1/5 = 0.20 / 1/1 = 1.00 | 501ms |
| dev-smoke-0009 | 9.730초 | 20 | SMOKE | 1 / 0 / 0 | 1/1 = 1.00 / 1/1 = 1.00 | 500ms |

세 실행의 지연으로 건너뛴 샘플은 모두 0이다. 표의 지연은 영상 재생 시각 기준 정답 시작→첫 일치 경보이며 API 도착 시간이나 모델 연산 시간과 다르다. FIRE 영상의 SMOKE, SMOKE 영상의 FIRE는 각각 TP/FP/FN 0/0/0이고 정밀도·재현율은 null이다.

기존 [매칭 규칙](a04-event-evaluation.md)을 유지했다: 같은 클래스 경보의 간격이 1000ms 이하이면 같은 예측 사건, 정답은 `[start_ms,end_ms)`, 예측 사건 시작 시각의 1:1 매칭, 허용 오차 0ms다. 촛불의 하나의 정답 구간에서 검출이 끊겼다 이어져 예측 사건 5개가 생겼다. 첫 사건만 정답과 매칭하고 나머지 4개는 중복 예측 FP다. **정상 장면에서 불꽃을 잘못 본 4건이라는 의미는 아니다.** 검출 연속성 한계와 매칭 결과를 숨기지 않으며 결과를 본 뒤 규칙을 바꾸지 않았다.

정상 영상의 FIRE·SMOKE 오탐률은 각각 관측상 0건/8.680초 = 0건/시간이다. 매우 짧은 LED 촛불 장면이므로 장시간 정상 CCTV 신뢰성을 입증하지 않는다. 촛불 장애 주입 재실행 2건은 같은 장면의 중복이어서 성능 표에 넣지 않았다. 개발 7개 전체 점수나 영상별 비율의 단순 평균도 산출하지 않았다.

## 재현

저장된 A06 actual04 원본 로그와 이 저장소의 개발 정답을 사용한다. 원본 로그는 Git에 없고 실행 PC의 `runs/preview-73-actual04/ai/`에 보존되어 있다. 공개 JSON의 `inputs.predictions_sha256`과 정답 해시를 먼저 대조한다. 출력 경로는 존재하는 폴더의 새 파일로 지정한다. 평가기는 기존 출력을 덮어쓰지 않는다.

```sh
python -m tools.evaluate_ai --predictions runs/preview-73-actual04/ai/a2fa87fa-0c17-46ee-a777-76dab06eaab8/ai-predictions.jsonl --ground-truth data/expected/ai/development/dev-flameless-candle.json --output runs/normal-development-evaluation.json
python -m tools.evaluate_ai --predictions runs/preview-73-actual04/ai/a041d93b-9bb1-4517-8d2a-883e363ecc39/ai-predictions.jsonl --ground-truth data/expected/ai/development/dev-candle-match.json --output runs/fire-development-evaluation.json
python -m tools.evaluate_ai --predictions runs/preview-73-actual04/ai/5df521e9-3ef7-4e1f-b69a-22bda04506f0/ai-predictions.jsonl --ground-truth data/expected/ai/development/dev-smoke-0009.json --output runs/smoke-development-evaluation.json
```

각 원본 보고서는 `runs/a04-96-development/`에 보존한다. 공개 근거의 config는 개인 PC 절대 경로인 `model_path`만 제외했으며 원본 보고서에는 그대로 있다. 원본 영상·가중치·전체 로그·평가용 사건 구간은 이 변경에 추가하지 않았다.

## 인계 준비 상태와 남은 작업

Q01 정답 파일 12개의 형식과 메타데이터만 검사했다. 평가용 사건 구간을 출력하거나 예측과 비교하거나 모델·설정 조정에 사용하지 않았다. 메타데이터 스냅샷과 각 파일 해시는 공개 근거 JSON에 있다. 이후 정답 수정 시 해당 해시를 기준으로 다시 검사해야 한다.

| 구분 | 확인 결과 | 다음 조건 |
|---|---|---|
| 개발용 7개 | 모두 현재 GroundTruth 형식 통과, reviewer=null 허용 | 나머지 CAVIAR 3개와 dev-joss-smoke는 이번 실제 로그 대조 대상에 없음 |
| 평가용 5개 | 모두 reviewer=null | 평가기의 기존 독립 검수자 조건 미충족. 담당 5의 검수·기록 필요 |
| eval-mm-polyurethane-bright | annotation_complete=false | 미확정 주석 완료 및 검수 필요 |
| 전체 12개 | training_overlap=unknown | 학습 자료와의 독립성이 입증된 것으로 표시하지 않음 |

평가용 정답을 임의 수정하거나 형식 제한을 풀어 평가를 통과시키지 않는다. `schema_ready`는 형식 검사 결과일 뿐 실제 영상 확보·해시 대조·주석 정확성·평가 조건 합의까지 준비됐다는 뜻이 아니다. 개발용 정답도 독립 재검수 완료를 주장하지 않는다.

- #9: 모델 최종 채택과 팀 프로젝트 라이선스 결정.
- #12: 평가 영상 목록·모델/설정·매칭 규칙·숫자로 된 목표·책임자·고정 시각의 합의. 저장소의 기존 목표는 미정이므로 합격 기준을 만들어 넣지 않는다.
- #30: 위 조건 충족 후 평가용 실제 추론, 누락·오탐·실패 실행을 포함한 집계와 담당 5의 독립 대조.
- #41: 설명 결과의 담당 5 독립 V15 검수와 전체 통합 증거.

이번 호환 수정과 개발 대조 완료로 위 상위 이슈를 닫지 않는다. 출처가 불명확한 기존 로컬 연기 임계값 실험도 이 작업에 포함하지 않았다.
