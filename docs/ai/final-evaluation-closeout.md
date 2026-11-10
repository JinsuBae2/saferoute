# A03·A04·A05 마감 평가 기록

사용자의 남은 #12·#30·#41 마무리 지시에 따라, 추가 모델 개발을 멈추고 고정한 평가5개 전체를 실제 지원 서버에서 실행한다. 작업 종료와 성능 합격은 별개다. 아래 결과는 **담당1의 실행·AI 보조 검수 기록**이며 담당5 사람의 독립 서명이 아니다.

## 평가 전 고정과 검수 범위

- 제품 소스: `e191256272b94fdc6107405c5dcf0f2bc42ab486`. 평가 중 AI·백엔드·평가 도구·설정은 변경하지 않았다.
- 모델/프로토콜 잠금: 2026-11-10 13:50:41 UTC. 정답 파일 동결: 13:58:24 UTC. 최초 추론 시작보다 앞선다.
- [최종 동결](final-evaluation-lock.json): 이미 시연 인계에 선택한 ONNX/CLAHE/native CPU4 프로필, confidence0.25·500ms·window1500/min2. 원 PT 제안은 [이전 제안서](evaluation-freeze-proposal.json)에 보존했다.
- 가중치 SHA-256 `4163c96eef1ebab77c7f073d0d4001feffda64fbc544f441abf4ca8f4fd69929`. 새 학습 후보는 사용하지 않았다.
- 사건 병합1000ms·경계 허용0ms·예측 시작 기준 일대일 대응, FIRE/SMOKE 정밀도80%·재현율90%, 정상 시간당 오탐1 이하, 대응 지연3000ms 이하, 늦은 샘플 폐기/EOF 전 만료0, 전송/EOF/로그 통과 기준을 유지했다.
- 정답 원 작성자는 준영으로 유지했다. Codex가 전체 길이에 걸친 표본 이미지와 점화·연기 경계 확대를 확인하고 실제 검수명을 기록했다. polyurethane 미완료 표시는 이 검수 범위에서 완료했으며 사건 구간은 5건 모두 수정하지 않았다. [검수 전후 메타데이터·방법·불확실성](final-evaluation-annotation-review.json).
- 긴 영상10초/짧은 영상2초 표본과 마지막 프레임, 점화/연기 경계200~500ms 및 추가 확대를 확인했다. 모든 프레임의 사람 검수나 밀리초 경계 인증이 아니다. 작은 점화와 점진적 연기 시작의 경계 불확실성은 지연 수치에 영향을 준다.
- 모델/설정 잠금 뒤에만 평가 장면을 보았고, 평가 결과로 모델·임계값·정답·매칭을 조정하지 않았다. 학습 출처와 평가 영상 중복은 `unknown`이다.

## 실제 실행과 집계

최초5개 전체 실행·집계 완료. **고정 기준 전체 판정: FAIL**. [공개 수치·해시·실패 근거](../../deploy/resource-checks/2026-11-10-final-evaluation.json).

| 영상 | 분석 샘플 | FIRE TP/FP/FN | SMOKE TP/FP/FN | 늦은 샘플 폐기 / 관측 만료 |
|---|---:|---|---|---|
| eval-caviar-walkbyshop1cor | 189 | 0/0/0 | 0/0/0 | 0 / 0 |
| eval-fs-reflections | 37 | 0/0/0 | 0/0/0 | 0 / 0 |
| eval-mm-heptane-bright | 720 | 1/10/0 | 0/0/0 | 0 / 0 |
| eval-mm-mist-bright | 600 | 0/0/0 | 0/16/0 | 0 / 0 |
| eval-mm-polyurethane-bright | 720 | 1/32/1 | 1/0/0 | 0 / 0 |

| 전체 지표 | FIRE | SMOKE |
|---|---|---|
| 사건 정밀도 | 4.55% (2/44) | 5.88% (1/17) |
| 사건 재현율 | 66.67% (2/3) | 100.00% (1/1) |
| 대응 사건 최대 지연 | 23520ms | 66220ms |
| 정상/혼동 영상 오탐 | 0건 / 412.430초 | 16건 / 412.430초 |
| 정상/혼동 영상 시간당 오탐 | 0.000건/시간 | 139.660건/시간 |

분석2266샘플, 늦은 샘플 폐기0건, 관측 만료0건. 영상 루프 처리량2.001샘플/초는 재생 대기·전송·로그를 포함하며 순수 모델 추론 FPS가 아니다. 자체 제어기 종료: True. 공개 결과에 영상별 EOF·전송·로그 검사와 실제 패키지/장비를 기록했다.

실패 분석: heptane의 한 FIRE 정답에 예측11개가 끊겨 생겨 첫 대응1개 외10개는 중복 FP이며 첫 대응 지연9,520ms다. mist는 정상 혼동 영상인데 SMOKE 예측16개가 발생했다. polyurethane는 짧은 FIRE 정답1개를 놓쳤고 지속 FIRE 정답에 대응1개·추가 중복32개가 생겼다. 대응 FIRE 지연23,520ms, SMOKE 지연66,220ms였다. 모든 미검출·추가 중복 및 정확한 시각은 공개 결과의 missed_events/predicted_events를 그대로 보존한다. 수증기 오인·사건 분절·감지 지연을 해결한 것으로 표시하지 않는다.

목표별 결과: FIRE_precision=FAIL, FIRE_recall=FAIL, FIRE_normal_fp_per_hour=PASS, FIRE_max_matched_delay_ms=FAIL, SMOKE_precision=FAIL, SMOKE_recall=PASS, SMOKE_normal_fp_per_hour=FAIL, SMOKE_max_matched_delay_ms=FAIL, skipped_late_frames=PASS, source_expirations=PASS, payload_match=PASS, log_integrity=PASS, freshness_pass=PASS, retained_alarm_causes=PASS, eof_unavailable=PASS, controller_stopped=PASS.

표본 정상 오탐률은 짧은412.430초를 시간 단위로 환산한 값이다. 실환경 장시간 오탐 빈도나 현장 일반화 보장이 아니다.

전체 목록은 정상 복도94.400초, 반사18.030초(주석 분모; 컨테이너18.033초), heptane360초, mist300초, polyurethane360초다. 세 정상/혼동 영상의 합은412.430초다. 5개 영상은 선언된 장면군3개이며 실험실3개를 독립 장면3개로 세지 않는다.

개발용 검증기의 평가 입력 차단을 우회하지 않고 [별도 일회 실행 기록기](../../deploy/resource-checks/2026-11-10-final-evaluation-runner.py)에서 실제 `ai_worker`와 기존 평가기를 호출했다. 각 영상은 새로운 run_id로 최초1회 실행했고 자체 TWO_ROUTE 제어기만 사용했다. 원본 H.264 바이트를 사용해 변환본/원본 정답 혼용이 없다.

첫 서버 준비 명령은 배포 패키지 이름을 `openvino`로 조회해 추론 전에 중단됐다. 설치된 이름 `onnxruntime-ep-openvino`로 메타데이터 조회만 고쳤다. 모델·정답·설정은 유지했고 추론을 골라 재실행하지 않았다. 평가 기록기/동결의 최종 해시는 공개 결과에 연결했다.

## 설명7건 대조

[Codex 문장 대조](v15-ai-closeout.json)는 원본 응답·근거·출처 해시·JSON 위치·run_id·안내 버전을 다시 확인했다. G01/G02/G07/G09 및 실제 관제 NORMAL/FIRE 표시6건에서 명확한 사실 모순을 찾지 못했다. G04의 “이들을 연결하는 경로”는 A/B에 인접한8개 방향 간선을 뜻하는지 모호하다. 직접 A–B 간선은 없으므로 이를 명확한 직접 경로 설명으로 승인하지 않는다. 역사적 실제 응답은 고쳐 쓰지 않았다.

실제 `claude-fable-5-1`의 별도 텍스트 검토에는 [7개 원문과 당시 사실](v15-independent-review.json) 전부를 제공한다. 최종 실제 모델·문장별 판단·시각은 PR과 로컬 Orchestra 영수증으로 남긴다. Fable이 영상을 보거나 직접 시험을 실행했다는 의미가 아니다. 담당5 사람의 작업지는 `PENDING`을 유지하며 서명을 대신하지 않는다.

실제 Bedrock 호출·표시·작업자 종료 중 제어 유지 근거는 [A05-2](a05-explanation-api.md), [A05-3](a05-browser-validation.md)다. 이번 신규 Bedrock 호출은0회다. 403/429/timeout 등 주입 시험은 실제 AWS 오류를 발생시킨 결과로 표시하지 않는다.

## 재현과 종료 범위

원본 결과 묶음 `final-evaluation-12-results.tar.gz`, 실행 소스 묶음 `final-evaluation-12-source.tar`와 영상/모델은 Git 밖에 보존하며 공개 결과의 SHA-256으로 대조한다. 두 묶음을 저장소 `runs/`에 놓고 결과 묶음만 `runs/final-evaluation-12-results/`에 푼 뒤, 고정된 정답과 기존 core 의존성을 사용한다.

Windows git archive가 내보낸 실행 소스는 CRLF이므로 Git blob의 LF 해시와 원시 해시가 다르다. 서버 원시 바이트는 소스 묶음과 모두 일치하며, CRLF를 LF로 정규화한 바이트는 고정 제품 커밋과 모두 같음을 대조했다. 공개 결과에는 서버 원시 해시와 정규화 해시를 구분한다. 최초 로컬 재검산은 이 바이트 차이를 검출해 중단했으며 소스나 추론을 바꾸지 않고 비교 대상을 바로잡았다.

```sh
PYTHONPATH=. python deploy/resource-checks/2026-11-10-final-evaluation-proof.py
```

이 검사는 모든 AI 원본 로그를 기존 영상별·전체 평가기로 재계산하고 서버 수신·유효기간·EOF·제어 로그 무결성, 제품 소스/설정/모델/정답·실행 시각을 연결한다. 공개 문서는 원본 검증을 대신하지 않는다.

#12는 평가 전 고정, #30은 전체 실행·수치·실패 분석, #41은 실제 연결 근거와 설명 대조를 마감 산출물로 정리한다. 원래 계획의 **담당5 사람 독립 대조는 미수행으로 남기고** 사용자 마감 지시에 따라 담당1 실행 범위를 종료한다. 성능 목표 미달을 합격으로 바꾸거나 미수행 검수를 체크하지 않는다. WFI 공동 시연·상시 배포 인수는 이 TWO_ROUTE 평가에 포함하지 않는다.
