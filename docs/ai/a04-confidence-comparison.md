# A04-4 confidence 0.10 개발 후보 비교 — 채택하지 않음

담당 1의 [#102](https://github.com/JinsuBae2/saferoute/issues/102). [개발 7개 기준](a04-seven-development.md)의 연기 미검출·촛불 중복 예측을 개선할 수 있는지, 기존 런타임의 confidence만 **0.25 → 0.10**으로 낮춘 후보 하나를 비교했다. 실행 전에 이슈에 후보와 전체 영상 목록 범위를 정했다. 결과를 본 뒤 추가 후보를 탐색하거나 정답·매칭·기본 설정을 바꾸지 않았다.

**이 후보는 채택하지 않는다.** 미검출과 중복 예측을 해결하지 못하고 정상 영상의 오탐이 늘었다. 기존 `configs/ai.example.json`은 0.25를 유지한다. [후보 설정](../../configs/ai.confidence-010.development.json)은 이 실패 결과의 재현 전용이며 운영 권장값이 아니다. 이 결론은 0.10 후보에 한정하며 모든 다른 설정·모델의 개선 가능성을 판단한 결과가 아니다.

## 실제 비교

같은 모델 SHA256 `b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f`, 입력 크기 640, 간격 500ms, 지속 창 1500ms/최소 2회, 원본 개발 영상 7개, 정답 바이트·1000ms 사건 묶음·1:1 시작 시각 매칭을 사용했다. 제품 런타임과 평가 코드는 기준 실행과 LF 정규화 해시가 같다. 전체 수치·영상별 사건·실패 기록·입출력 해시는 [공개 JSON](../../deploy/resource-checks/2026-11-10-ai-confidence-development.json)에 있다.

| 개발 사건 지표 | 기준 0.25 | 후보 0.10 |
|---|---:|---:|
| FIRE TP / FP / FN | 1 / 4 / 0 | 1 / 10 / 0 |
| FIRE 정밀도 / 재현율 | 20% / 100% | 약 9.09% / 100% |
| SMOKE TP / FP / FN | 1 / 0 / 1 | 1 / 5 / 1 |
| SMOKE 정밀도 / 재현율 | 100% / 50% | 약 16.67% / 50% |
| 정상 영상 FIRE 오탐 | 0 | 6 |
| 정상 영상 SMOKE 오탐 | 0 | 5 |
| 촛불 동일 정답의 FIRE 중복 예측 | 4 | 4 |
| Tai Po SMOKE 미검출 | 1 | 1 |
| 일치한 사건 지연 FIRE / SMOKE | 501ms / 500ms | 501ms / 500ms |

정상 영상은 두 실행 모두 4개, 137.320초다. 후보의 시간당 환산은 FIRE 약 157.30건, SMOKE 약 131.08건이지만, 약 2.3분 관측의 산술 환산이며 장시간 현장 오탐률을 측정한 값이 아니다. CAVIAR 3개는 같은 로비 장면 그룹이며 전체 7개는 5개 장면 그룹이다. 분모가 없는 클래스/영상의 지표는 기존처럼 null이다.

후보의 정상 오탐은 기준의 촛불 중복 FP와 구분한다. FIRE FP 10건은 촛불 중복 4건과 정상 영상 6건의 합계이며, SMOKE FP 5건은 정상 영상에서 발생했다. 놓친 연기 사건은 FN 분모에 그대로 남는다. confidence는 모델 점수이며 화재 확률을 뜻하지 않는다.

## 실행·실패·환경

기준 런타임은 `3fd479f38bef51abd1ebe0d9d9af14cbada2a1cb`, Windows CPU·Python 3.12.16·torch 2.15.0+cpu·ultralytics 8.4.208·OpenCV 5.0.0.93다. 자체 loopback TWO_ROUTE에서 순차 실행했으며 새 서버/Bedrock/브라우저/배포 검증은 하지 않았다.

1. `runs/a04-102-actual01`: PATH에 ffprobe가 없어 첫 촛불 사전 검사에서 `VIDEO_PREFLIGHT_UNAVAILABLE / FileNotFoundError`로 중단했다. 분석 0프레임, UNAVAILABLE 전송 1개, 나머지 6개는 미시도다. 실패 로그와 해시를 보존했고 자체 제어기는 종료했다.
2. `runs/a04-102-actual02`: 이미 준비된 ffprobe를 PATH에 추가하고 **같은 설정·입력 바이트**로 전체 7개를 실행했다. 358샘플·366수신(EOF 7개 포함), 건너뜀·관측 만료 0. 전송/수신 payload 일치, 모든 EOF·제어 로그 무결성 통과, 자체 제어기 종료를 확인했다. 한 샘플에서 두 클래스 ALARM이 전송될 수 있어 수신 수가 기준의 365개와 다르다.

첫 실패를 정확도 집계에 더하거나 성공 실행으로 표시하지 않았다. 두 번째 실행은 결과에 따른 선택적 재시도가 아니며, 환경 오류를 고친 전체 실행이다. `prior_failed_attempts`에 실패와 당시 미시도 목록을 남겼다.

사전 프레임 수 검사 도구는 기준 `N-124716-g054dffd133-20260531`, 후보 `9.0.2-essentials_build-www.gyan.dev`로 다르다. **7개 모두 사전 전체 디코딩 프레임 수와 최종 읽은 프레임 수가 일치**하고 실제 추론을 수행한 OpenCV/torch/ultralytics·소스·영상·모델은 동일함을 대조했다. ffprobe 버전 차이와 실행 시점의 부하를 무시한 속도 개선 주장은 하지 않는다. 사건 지연은 영상 시각의 매칭 결과다.

## 재현

기존 AI lock 환경과 ffprobe를 준비한다. 개발 manifest는 [A04-3 인계 규칙](a04-seven-development.md#재현도구-인계)에 따라 원본 해시를 유지하고 path만 실제 위치로 지정한다. 후보 설정은 model_path만 실제 가중치 경로로 바꾼 로컬 사본을 사용한다. 원본 manifest·기본 설정·정답을 덮어쓰지 않는다.

```sh
ffprobe -version
python -m tools.validate_ai_delivery --output runs/a04-confidence-new --manifest runs/a04-102-input/manifest.json --config runs/a04-102-input/ai.local.json --asset-id dev-candle-match --asset-id dev-caviar-browse-whilewaiting2 --asset-id dev-caviar-meet-walktogether1 --asset-id dev-caviar-walk1 --asset-id dev-flameless-candle --asset-id dev-joss-smoke --asset-id dev-smoke-0009
python -m tools.evaluate_ai --predictions runs/a04-confidence-new/ai/RUN_ID/ai-predictions.jsonl --ground-truth data/expected/ai/development/ASSET_ID.json --output runs/ASSET_ID-confidence-evaluation.json
```

입력 경로는 이번 실행 PC의 로컬 파일이며 다른 PC에서는 준비한 경로를 지정한다. 출력 폴더/보고서는 새 경로를 사용하고 7개 각각 평가한다. 공개 JSON의 config는 개인 PC model_path만 제외했고 원본 config·보고서 해시는 보존했다. 공개 소스/후보 설정 해시는 CRLF→LF 정규화, 원본 영상·로그·보고서는 실제 바이트 기준이다.

## 남은 범위

개발 비교는 끝났지만 기존 모델의 연기 미검출·촛불 중복은 해결되지 않았다. 최종 모델/팀 라이선스, 평가 전 목표/조건 합의, 담당 5의 독립 주석·결과 대조는 [담당 1 인계](role1-handoff.md)의 보류 상태를 유지한다. 평가용 영상·정답과 원래 작업 폴더의 미커밋 연기 실험을 사용하지 않았다. 이 결과를 독립 성능 합격이나 프로젝트 출시 승인으로 바꾸지 않는다.
