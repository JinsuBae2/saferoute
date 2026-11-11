# A04-3 개발 영상 7개 전체 기준 실행

담당 1의 [#98](https://github.com/JinsuBae2/saferoute/issues/98). [A04-2의 개발 3개 대조](a04-development-comparison.md) 이후, Q01 `saferoute-q01-reviewed-v2/01_development`의 **7개 전부를 같은 기본 설정으로 새로 실행**했다. 기준 develop은 `23fd30f5d79bbbe27f9f4c66be789aa91190e90a`이고 이 변경의 검증 도구를 사용했다. 실제 실행 소스의 LF 정규화 SHA256과 영상·설정·정답·로그·산출물 해시는 [공개 근거 JSON](../../deploy/resource-checks/2026-11-10-ai-seven-development.json)에 있다.

**전송/실행 검증은 통과했지만, 감지 성능 합격이나 모델 최종 채택은 아니다.** 모델이 놓친 연기와 중복 불꽃 경보를 분모에 남겼다. 평가용 영상·사건 정답, 기존 로컬 연기 임계값 실험은 사용하지 않았다.

## 실행 조건

- 모델: `rabahdev/fire-smoke-yolov8n`, SHA256 `b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f`.
- 설정: 기존 `configs/ai.example.json`의 640 / 500ms / confidence 0.25 / window 1500ms / min_detections 2. 로컬 가중치 절대 경로만 치환했다. 이벤트·지속 조건·매칭 규칙·정답 변경 없음.
- 환경: Windows CPU, 논리 CPU 16, torch threads 4, Python 3.12.16, torch 2.15.0+cpu, ultralytics 8.4.208. 실행별 전체 패키지 버전은 공개 JSON에 있다.
- 자체 loopback `TWO_ROUTE` / `CAM-A`, 영상별 새 run_id로 순차 실행. 미리보기 비활성. 기존 서버·Bedrock·운영 서비스에 접속하지 않았다.
- 영상별 1회, 결과에 따른 재시도·선별 없음. 7개 모두 정답과 Q01 인계 manifest의 영상 해시·scene_id가 일치한다. CAVIAR 3개는 같은 로비 장면 그룹이므로 7개의 독립 장소로 세지 않는다(전체 scene_id 5개).
- CAVIAR 3개도 이번부터 개발 추론에 사용했다. 공개 근거에 `development_used=true`를 기록했으며 원래 인계 패키지의 준비 시점 메타데이터를 덮어쓰지 않았다. 향후 독립 평가로 옮기지 않는다.

## 실제 결과

| 개발 영상 | 길이(초) | 분석 샘플 | FIRE TP/FP/FN | SMOKE TP/FP/FN |
|---|---:|---:|---|---|
| dev-candle-match | 25.470 | 51 | 1/4/0 | 0/0/0 |
| dev-caviar-browse-whilewaiting2 | 75.840 | 152 | 0/0/0 | 0/0/0 |
| dev-caviar-meet-walktogether1 | 28.320 | 57 | 0/0/0 | 0/0/0 |
| dev-caviar-walk1 | 24.480 | 49 | 0/0/0 | 0/0/0 |
| dev-flameless-candle | 8.680 | 18 | 0/0/0 | 0/0/0 |
| dev-joss-smoke | 5.170 | 11 | 0/0/0 | 0/0/1 |
| dev-smoke-0009 | 9.730 | 20 | 0/0/0 | 1/0/0 |
| 합계 | 177.690 | 358 | 1/4/0 | 1/0/1 |

합산 TP/FP/FN으로 계산한 **개발 사건 지표**다. 이전 3개 실행을 다시 더하지 않았으며 영상별 비율을 단순 평균하지 않았다.

| 클래스 | 정밀도 | 재현율 | 일치한 사건의 지연 |
|---|---|---|---|
| FIRE | 1/(1+4) = 20% | 1/(1+0) = 100% | 1건, 501ms |
| SMOKE | 1/(1+0) = 100% | 1/(1+1) = 50% | 검출한 1건만 500ms; 놓친 사건은 FN으로 별도 기록 |

정상 4개(로비 CCTV 3개 + LED 촛불 1개) 총 **137.320초**에서 두 클래스 모두 오탐 0건이다. 관측상 시간당 오탐은 각각 0이지만, 약 2.3분의 짧고 제한된 자료로 장시간 현장 신뢰성을 입증하지 않는다. 정상 로비 CCTV만의 길이는 128.640초다. 클래스별 정답/예측 분모가 0인 영상의 정밀도·재현율은 0이나 100%가 아닌 null로 보존한다.

전체 **358샘플, 수신 이벤트 365개(영상별 EOF 7개 포함), 샘플 건너뜀 0, 관측 만료 0**을 확인했다. 모든 전송/수신 payload가 일치하고 EOF 이후 CAM-A는 UNAVAILABLE, 기존 경보 원인은 유지됐다. 종료한 실행 7개 모두 제어 로그 무결성 검사 통과, 자체 제어 프로세스 종료 확인. 취득→수신 감사 기록 최대 538.310ms, 관측 수신 간격 최대 547ms, 취득 지연+다음 수신 간격 최대 1021.085ms였다. 이는 Windows/loopback 실측이며 원격 전송 보장값이 아니다.

사건 지연은 영상 시각 기준이며 모델 연산 시간이나 네트워크 지연이 아니다. 처리량·실행 루프 시간·read-to-completion은 영상별 공개 JSON에 원래 의미대로 보존한다. 재생 대기·전송·로그 비용이 포함되므로 순수 모델 FPS로 표시하지 않는다.

## 확인한 실패와 해석

- **Tai Po 연기 미검출:** 11샘플을 정상 처리하고도 SMOKE 경보가 없어서 정답 1건을 놓쳤다. 전송 성공을 감지 성공으로 해석하지 않는다. SMOKE 재현율의 분모에 이 사건을 포함한다.
- **촛불 검출 단절:** 하나의 FIRE 정답 구간에 예측 사건 5개가 생겼다. 기존 1000ms 경보 묶음·시작 시각 1:1 매칭 규칙에서 첫 사건은 TP, 나머지 4개는 중복 FP다. 정상 장면에서 발생한 오탐 4건이라는 뜻이 아니다.
- 실행 실패·미실행 영상은 이번 7개 실행에서 각각 0건이다. 모델의 미검출과 중복 예측은 위 지표에 남아 있으며 `failed_runs=[]`를 감지 결함 없음으로 읽지 않는다.

이번 결과를 보고 임계값이나 매칭 규칙을 바꾸지 않았다. 추가 개선은 개발 자료에서 별도 버전으로 비교하고 기존 결과를 보존해야 한다. 학습 중복은 7개 모두 unknown, 개발 정답 reviewer는 null이며 독립 주석 품질 인증이 아니다.

## 재현·도구 인계

AI lock 환경과 PATH의 ffprobe가 필요하다. 인계 패키지 원본은 수정하지 않는다. `--manifest`에는 기존 `videos` 형식의 개발 영상 항목을 사용한다(`asset_id`, `split=development`, `path`, `sha256`). 상대 path는 저장소 루트 기준이며 외부 인계 폴더의 영상은 절대 path로 지정할 수 있다. Q01 manifest의 해당 7개 항목을 복사하고 path만 실제 파일 위치로 치환하면 된다. SHA256을 새 파일에 맞춰 바꾸지 않고 인계본과 동일한지 먼저 대조한다.

`--config`에는 기존 예제와 동일한 설정을 쓰고 model_path만 실제 가중치 위치로 지정한다. 도구는 실행 전에 설정을 검사하고 출력 폴더의 `ai.config.json`으로 복사해 모든 영상에 같은 바이트를 사용한다. 로컬 절대 경로를 포함한 manifest/config는 Git에 올리지 않는다.

```sh
python -m tools.validate_ai_delivery --output runs/a04-seven-new --manifest runs/a04-98-input/manifest.json --config runs/a04-98-input/ai.local.json --asset-id dev-candle-match --asset-id dev-caviar-browse-whilewaiting2 --asset-id dev-caviar-meet-walktogether1 --asset-id dev-caviar-walk1 --asset-id dev-flameless-candle --asset-id dev-joss-smoke --asset-id dev-smoke-0009
```

위 두 입력 파일은 이번 실행 PC에 보존된 로컬 파일이다. 다른 PC에서는 앞의 규칙대로 준비한 manifest/config 경로로 바꾼다. 출력은 새 폴더여야 한다. `--asset-id`는 반복 가능하고 중복/미등록/중복 manifest 항목/평가 split은 서버 시작 전에 거부한다. 선택 옵션을 생략하면 기존 정상·촛불·짙은 연기 3개 및 두 경보 클래스 확인 동작이 유지된다. 명시적 선택 모드에서는 정상 영상만 고를 수도 있으므로 경보 두 클래스 발생을 강요하지 않는다. 이 모드의 PASS는 전송·EOF·로그·유효기간 검증이며 감지 성능 판정은 항상 `NOT_ASSESSED`다.

이후 각 run_id 로그를 **개발 정답만** 사용해 평가한다. 영상별 실제 run_id·입력/산출물 경로와 해시는 공개 JSON의 `cases`에 있다.

```sh
python -m tools.evaluate_ai --predictions runs/a04-seven-new/ai/RUN_ID/ai-predictions.jsonl --ground-truth data/expected/ai/development/ASSET_ID.json --output runs/ASSET_ID-development-evaluation.json
```

이번 원본 실행은 `runs/a04-98-actual01`, 전체 요약은 `summary.json`, 영상별 사건 보고서는 `ASSET_ID.evaluation.json`이다. 공개 JSON은 config의 개인 PC model_path만 제외했으며 원본 보고서와 설정 스냅샷의 해시는 그대로 보존한다. 단일 실행 도중 처리 오류가 나면 기존처럼 중단하고 실패를 보고하므로 남은 영상은 통과로 간주하지 않는다.

## 남은 결정

이번 7개 개발 기준 결과로 #9 최종 채택을 자동 결정하지 않는다. 팀 프로젝트 라이선스와 모델 채택, #12 평가 조건·수치 목표·책임자·고정 시각의 합의, #30 검수 완료된 독립 정답으로 평가·담당 5 대조, #41 독립 V15/전체 통합은 남아 있다. 평가용 정답 준비 상태는 A04-2의 해시별 스냅샷이며 이번에는 평가용 정답을 다시 읽거나 평가하지 않았다.
