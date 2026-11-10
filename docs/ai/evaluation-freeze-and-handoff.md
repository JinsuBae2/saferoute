# 담당 1 모델 추천·평가 동결 제안·담당 5 인계

2026-11-10, #114 준비안에 #9의 [선정·승인 기록](a01-selection-acceptance.md)을 반영했다. **모델 선정·자체 코드 AGPL-3.0-only·수치 기준은 승인됐고 최종 실행 자료는 동결 전이다.** 담당5의 독립 검수는 대신하지 않는다. 평가용 영상 추론·구간 정답 열람·튜닝은 수행하지 않았다.

## 선정한 모델과 사용 조건 — #9

담당 1의 추천은 **xiazh 후보, confidence 0.25**다. [개발 7개 비교](a01-alternative-models.md)에서 기존 모델의 얇은 연기 미검출을 검출했고, [실제 서버 비교](a01-alternative-server.md)에서 358/358 샘플·전송·3초 유효기간을 확인했다. [#114 추가 비교](a01-readiness-validation.md)의 0.15 후보는 정상 LED 영상의 연기 오탐을 늘려 추천하지 않는다. 후속 #9 결정으로 독립 평가·향후 통합 시연 대상에 선정했다. 성능 합격·운영 배포 승인과는 다르며 기존 기본 예제 대신 xiazh 설정을 명시해야 한다.

| 고정할 후보 항목 | 추천 값 |
|---|---|
| 원저자·revision | `xiazh0219/yolo26m-UAV-fire-smoke-detection`, `57cf971a788fff62b8f3e5b1c3632e1214b8255c` |
| 가중치 SHA-256 | `a06febf257bff40cf5f3814e77f5120e2a80ab91d3ff3a84370caf6fdf832740` |
| 클래스 | 실제 로드 이름 `0: fire`, `1: smoke` |
| 설정 | [ai.xiazh.development.json](../../configs/ai.xiazh.development.json), 640 / 500ms / confidence 0.25 / window 1500ms / min 2 |
| 실행 환경 | [고정 AI 환경](../../requirements-ai.lock.txt), 지원 서버 CPU 4스레드, 단일 작업자 |
| 알려진 한계 | FIRE·SMOKE 중복 사건 각 1건, 정상 표본 137.320초, 학습 자료 중복 미확인 |

원저자 모델 카드의 AGPL-3.0 표기와 모델/학습 자료 출처는 [A01-4](a01-alternative-models.md)의 revision별 근거를 사용한다. 게시자의 표기를 팀 코드·가중치·데이터 전체에 대한 사용 승인으로 바꾸지 않는다. **제출/공개/재배포 방침, 프로젝트 LICENSE, 출처 표기, 결정자·시각**은 #9의 승인 댓글과 LICENSE·NOTICE로 기록한다. 후속 #9에서 조대성의 위임 확인에 따라 모델과 AGPL-3.0-only 방침을 결정했고 LICENSE·NOTICE를 반영했다. 법적 적합성 인증이나 운영 배포 완료를 뜻하지 않는다.

## 승인한 기준과 남은 실행 동결 — #12

후속 #125 / [PR #131](https://github.com/JinsuBae2/saferoute/pull/131)의
[OpenVINO/CLAHE/native 개발 프로필](../../configs/ai.xiazh.clahe.native.development.json)은 위 선정 PT 설정과 별도다.
[개선 기록](a01-performance-improvement.md)에서 개발 SMOKE 정밀도2/2, FIRE1/2와
저해상도 정상 반복30분20초3641/3641·폐기0·관측 만료0을 확인했다.
위 표의 중복·기존 설정 결과를 새 프로필의 현재 결과로 혼동하지 않는다.
이 문서와 기계 판독 제안서는 기존 PT 설정을 유지한다. 최종 평가에 개선 프로필을 채택하려면
실행 전에 ONNX 해시·전처리·입력 크기 정책·provider/환경을 포함해 설정을 갱신하고 동결해야 한다.
코드 머지만으로 평가 설정이 변경되거나 성능 합격으로 바뀌지 않는다.

[기계 판독 제안서](evaluation-freeze-proposal.json)는 `CRITERIA_APPROVED_INPUTS_NOT_FROZEN`이다. 모델/설정, 매칭, 아래 수치 제안, 평가 자산 5개의 메타데이터·Git blob SHA-256을 담았다. Git blob 해시는 기준 커밋의 원본 바이트 기준이고 설정 해시는 키 정렬·공백 없는 JSON의 UTF-8 SHA-256이다. 미완료 정답의 해시는 **준비 상태 스냅샷**이며 최종 평가 정답 동결이 아니다. 파일명과 proposed_targets 키는 기존 준비안과의 연결을 위해 유지하며 실제 승인 근거는 approvals에 있다.

| 항목 | 승인한 기준 v1 | 판정 시 함께 제시할 것 |
|---|---|---|
| FIRE / SMOKE 사건 정밀도 | 각 0.80 이상 | TP·FP 및 분모, 중복 경보 사례 |
| FIRE / SMOKE 사건 재현율 | 각 0.90 이상 | TP·FN 및 분모, 놓친 사건 전체 |
| 정상 영상 오탐 | 클래스별 시간당 1건 이하 | 원시 FP와 실제 정상 길이. 짧은 표본의 0건을 장시간 신뢰성으로 해석하지 않음 |
| 감지 지연 | 영상 시각의 정답 시작→첫 대응 ALARM 최댓값 3,000ms 이하 | 모든 대응 지연과 FN. API 종단 지연과 구분하고 미검출을 지연 통과로 처리하지 않음 |
| 처리·전송 | 늦은 샘플 폐기 0, EOF 전 관측 만료 0, payload 일치, EOF/로그 검사 통과 | 예상/분석/건너뜀 프레임 수, 획득→수신과 관측 간격, 실패 로그 |
| 사건 매칭 | 동일 클래스 ALARM 간격 1,000ms 이하 병합, 경계 허용 0ms, 시작 시각의 `[start,end)` 일대일 대응 | [기존 A04 규칙](a04-event-evaluation.md), 미대응 예측 FP·정답 FN |

위 수치는 처음 합의용 안으로 작성했고 이후 #12 결정 댓글에서 조대성이 승인했다. 법정 기준은 아니다. 승인자·UTC시각·원문 링크는 approvals에 기록했다. 현재 개발 정밀도는 승인 기준보다 낮으며 기준 승인 자체를 합격으로 처리하지 않는다. 독립 표본이 부족하거나 분모가 0이면 N/A/자료 부족을 명시한다. 평가 후 목표를 바꾸면 새 프로토콜 버전이며 최초 통과로 소급하지 않는다.

동결 순서:

1. #9 모델·사용 조건과 #12 목표·매칭 결정을 approvals에 반영했다. 입력 준비·독립 검수와 실행 동결은 아래 순서로 완료한다.
2. 담당 5가 아래 주석/검수를 마치면 **최종** 정답 Git 커밋·파일 SHA-256, 실행 영상 SHA-256, 코드 커밋, 모델/설정 해시를 다시 기록한다. 이름만 같은 파일로 대체하지 않는다.
3. 제안서의 `approvals`, `frozen_by`, `frozen_at_utc`, `final_source_commit`, `final_ground_truth_hashes`를 실제 결정 근거로 채우고 동결본을 버전 관리한다. 기준 승인 2건은 기록했고 최종 코드·정답 해시 및 실행 동결의 null은 미완료 표시다.
4. 동결 이후 담당 1이 고정된 전체 평가 목록을 한 번 실행하고 원본 예측/전송 로그를 보존한다. 실패/미시도 영상을 제외하지 않고 기록하며, 실행·정답 해시가 일치할 때 `tools.evaluate_ai_suite`로 전체 합산하고 영상별 근거도 유지한다. 최초 결과를 보존하며 재실행은 사유·별도 ID로 기록한다.
5. 담당 5가 결과와 구간 정답을 독립 대조한다. 실패 분석 후 변경하려면 개발 자료에서 처리하고 독립 평가 재사용 여부와 새 버전을 명시한다.

지원 서버에서 디코딩 변환이 필요한 평가 입력은 실행 전에 별도 파생 해시·원본과의 전체 픽셀/시각 동등성을 기록해야 한다. 파생 로그를 원본 해시의 정답으로 억지 채점하지 않는다. 담당 5가 주석 구간은 유지하면서 검증된 실행 파일 해시와 정답의 연결을 확인한 후 동결한다. 개발 Smoke0009의 변환 성공을 모든 평가 영상의 변환 성공으로 간주하지 않는다.

## 담당 5가 넘겨줄 것 — #30

기준 develop `9d708d5`의 평가 파일은 아래와 같다. `events`, 정상 여부·구간 시각 등 평가 정답 내용은 개발 분석에 출력하지 않았고 메타데이터만 확인했다. 5개 모두 `development_used=false`, `training_overlap=unknown`이다. 학습 중복이 배제됐다는 뜻은 아니다. MMODAL 3개는 같은 `mmodalfire-lab-camera-ch01` 장면군이므로 독립 장면 3개로 세지 않는다.

| 평가 asset_id | annotation_complete | reviewer | 필요한 작업 |
|---|---|---|---|
| eval-caviar-walkbyshop1cor | true | null | 실제 독립 검수자 기록 |
| eval-fs-reflections | true | null | 실제 독립 검수자 기록 |
| eval-mm-heptane-bright | true | null | 실제 독립 검수자 기록 |
| eval-mm-mist-bright | true | null | 실제 독립 검수자 기록 |
| eval-mm-polyurethane-bright | false | null | 주석 완료 및 독립 검수 |

필요한 인계는 **전체 평가 영상 위치/원본 해시·사용 조건, 완성된 정답 PR/커밋, 독립 검수자, 알려진 학습 중복 확인 결과**다. 검수 전 `reviewer`에 이름만 채우거나 `annotation_complete=true`로 바꾸지 않는다. 1번은 정답이 완성되기 전에 평가 영상을 보고 모델을 조정하지 않는다. 개발 7개와 이번 반복 영상은 계속 개발 자료다.

## 설명 문장 검수도 바로 시작할 수 있음 — #41

[V15 독립 검수 작업지](v15-independent-review.json)에 기존 실제 Bedrock API 5개(G01/G02/G04/G07/G09)와 실제 브라우저 2개의 **원문 문장·fact_refs·당시 basis facts·run_id/안내 버전**을 모았다. 각 행은 원본 공개 증거의 경로·SHA-256·JSON pointer로 연결된다. 새 유료 호출 없이 담당 5가 바로 대조할 수 있으며 모든 독립 판정은 `PENDING`, reviewer/시각은 null이다.

담당 5는 문장의 각 위험·차단·출구·방향 주장이 해당 `basis_facts`에 있는지, 안전 단정이나 없는 사실을 만들었는지 확인한다. PASS/FAIL, 문제 문구와 대응 사실, 실제 검수자·UTC 시각을 남긴다. 실패한 문장은 담당 1에게 수정 근거로 돌려주며, 검수 완료 전 기존 개발 PASS를 V15 독립 PASS로 바꾸지 않는다.

[A05-3 장애 증거](a05-browser-validation.md)의 실제 설명 작업자 종료와 모의 응답 5개도 별도 확인한다. 모의 응답을 실제 AWS 403/429 발생으로 세지 않으며, 종료 후 두 단말의 reset 전 APPLIED ACK 109개씩과 reset 후 미확인 명령을 구분한다. WFI 전체 시연·상시 배포는 담당 2·3·4·5의 공동 검수로 남는다.

설명 이슈의 기술 완료와 독립 판정을 구분할 때 사용할 기존 근거:

| 기술 조건 | 구현·검증 근거 | 독립 검수와의 경계 |
|---|---|---|
| 현재 READY만 표시, PENDING/UNAVAILABLE·실행/건물/안내/기한 검사 | [서비스 시험](../../tests/test_explanation_service.py), [화면 판정 시험](../../web/src/control/controlModel.test.ts), [기한 시험](../../web/src/control/explanationTiming.test.ts), A05-3 실제 READY·작업자 종료와 모의 응답 5개 | TWO_ROUTE 개발 검증이며 WFI 전체 인수 검수 아님 |
| timeout·권한 거부·429·형식 오류·미등록 사실·지난 응답 비표시 | 서비스 시험의 지연 Future, AccessDeniedException/ThrottlingException 및 잘못된 응답 주입; 화면은 READY 이외 비표시 | 실제 AWS 권한/한도 오류 유발 시험으로 보고하지 않음 |
| 문장 내용의 사실 일치 | 위 7개 실제 문장과 당시 사실을 작업지에 인계 | 담당 5의 문장별 판정은 PENDING |

이 인계안으로 담당 1의 추천·설정안·실행 도구·기존 문장 증거 준비는 진행할 수 있다. #9의 모델·라이선스와 #12의 수치 기준 결정 대기는 해소됐으며, #12 실행 자료 동결·#30 독립 평가·#41 담당5 검수는 남는다.
