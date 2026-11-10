# A01-4 대체 불꽃·연기 모델 개발 비교

관련 이슈: [#105](https://github.com/JinsuBae2/saferoute/issues/105), 상위 #9/#30. 2026-11-10, 조대성 / Rinhaze.

## 비교 범위와 출처

기존 모델의 얇은 연기 미검출·촛불 경보 단절을 확인하기 위해 **기존 모델 + 대체 후보 2개**로 비교 범위를 고정했다. 개발 7개 전체를 모델마다 새로 실행했다. 기존 [confidence 0.10 비교](a04-confidence-comparison.md)와 별도 실험이며, 평가용 영상·정답과 원래 작업 폴더의 미커밋 연기 실험은 사용하지 않았다.

| 후보 | 고정 출처 | 실제 클래스 0 / 1 | 가중치 SHA256 |
|---|---|---|---|
| 기준 rabahdev YOLOv8n | [기존 모델 manifest](../../data/manifests/assets.json) | smoke / fire | `b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f` |
| luminous YOLOv8n | [원저자 저장소 c30923f](https://github.com/luminous0219/fire-and-smoke-detection-yolov8/tree/c30923f568d915a53fcf85989be9fe5d4e030518), `weights/best.pt` | fire / smoke | `ac0a10257b2bc1f20c9d957f8adeeb61dd6140322fc19d0b4a116cb491776d16` |
| xiazh 공개명 YOLO26m UAV | [모델 카드 57cf971](https://huggingface.co/xiazh0219/yolo26m-UAV-fire-smoke-detection/tree/57cf971a788fff62b8f3e5b1c3632e1214b8255c), `weights/best.pt` | fire / smoke | `a06febf257bff40cf5f3814e77f5120e2a80ab91d3ff3a84370caf6fdf832740` |

luminous는 Roboflow fire-and-smoke 학습 자료와 저장소 AGPL-3.0 LICENSE, xiazh는 FASDD·자체 UAV 학습 자료와 모델 카드 AGPL-3.0을 명시한다. 이는 게시자의 출처·조건 기록이며 학습 자료의 모든 권리나 팀 프로젝트 라이선스에 대한 승인으로 해석하지 않는다. xiazh의 모델명은 게시자의 이름을 그대로 기록했고 실내용 성능을 가정하지 않았다. 실제 로드한 파라미터는 luminous 3,011,238개, xiazh 21,775,972개다. 원본 README/args/LICENSE의 고정 URL·크기·해시는 공개 JSON의 provenance에 있다. 원저자 성능 수치는 우리 실측에 포함하지 않는다.

## 동일 조건과 최소 호환 수정

입력 640, 샘플 간격 500ms, confidence 0.25, window 1500ms, min_detections 2를 유지했다. 모델 경로/해시만 후보별로 다르다. GT 바이트·사건 매칭 규칙·영상 해시·샘플 프레임을 대조했다. 7개 총 177.690초, 정상 4개 137.320초이며 CAVIAR 3개는 같은 장면군이다(총 5개 장면군).

기존 Detector가 `{0: smoke, 1: fire}`만 허용해 반대 순서의 정상적인 두 클래스 모델을 거부했다. 정확히 fire/smoke 두 클래스와 0/1 인덱스인 경우 두 순서를 허용하고, 실제 이름으로 기존 FIRE/SMOKE 이벤트를 만든다. 실제 매핑은 시작 로그에도 기록한다. COCO·누락·중복·추가 클래스·잘못된 인덱스는 계속 거부하며 회귀 시험으로 확인한다. 공통 이벤트 계약·경보 창·기본 모델 설정은 바꾸지 않았다.

실행 기준 코드는 develop `44bd3376a0e23f5628419c2050689ad829da4768`에 이 호환 수정만 추가한 버전이며 실행 소스 해시를 공개 JSON에 남겼다. Python 3.12.16, torch 2.15.0+cpu, torchvision 0.29.2+cpu, ultralytics 8.4.208, OpenCV 5.0.0.93, numpy 2.5.4, CPU 4스레드, ffprobe 9.0.2-essentials_build-www.gyan.dev다. 기존 [AI lock](../../requirements-ai.lock.txt)에 후보 체크포인트용 [선택 의존성](../../requirements-ai-alternatives.lock.txt) dill 0.4.1만 추가했다. 실제로는 기존 환경을 수정하지 않고 `runs/a01-105-deps`에 설치해 세 모델 모두 동일한 PYTHONPATH를 사용했다.

luminous 첫 체크포인트 로드 시 dill 부재로 실패했다. 이는 영상 추론 시작 전 준비 오류다. 의존성을 준비한 뒤 각 모델의 전체 영상 실행을 한 번씩 수행했고, 성능이 낮다는 이유로 영상이나 실패를 제외하지 않았다.

## 재현 방법

저장소 루트에서 `requirements.txt`, `requirements-ai.lock.txt`, 선택 의존성을 갖춘 Python 3.12 CPU 환경과 ffprobe PATH를 준비한다. `runs/a01-105-input/manifest.json`은 Q01 개발 7개의 실제 로컬 경로를 넣은 manifest이며 각 원본 해시는 기존 개발 정답과 일치해야 한다. 공개 설정의 모델 경로를 내려받아 해시 확인한 로컬 파일 경로로 바꾼 설정을 준비한다. 기본/대체 설정은 [기준](../../configs/ai.example.json), [luminous](../../configs/ai.luminous.development.json), [xiazh](../../configs/ai.xiazh.development.json)이다. 실제 입력·원본 로그는 Git에 올리지 않는다.

```powershell
$env:YOLO_OFFLINE='true'
$env:YOLO_AUTOINSTALL='false'
$env:PYTHONPATH='.'
python -m tools.validate_ai_delivery --output runs/a01-105-luminous --manifest runs/a01-105-input/manifest.json --config runs/a01-105-input/luminous.json --asset-id dev-candle-match --asset-id dev-caviar-browse-whilewaiting2 --asset-id dev-caviar-meet-walktogether1 --asset-id dev-caviar-walk1 --asset-id dev-flameless-candle --asset-id dev-joss-smoke --asset-id dev-smoke-0009
python deploy/resource-checks/a01-105-benchmark.py --output runs/a01-105-bench-luminous --manifest runs/a01-105-input/manifest.json --config runs/a01-105-input/luminous.json
```

baseline/xiazh도 각 설정·새 출력 폴더로 같은 명령을 순차 실행한다. 순수 predict CPU 측정은 [측정 스크립트](../../deploy/resource-checks/a01-105-benchmark.py)로 별도 수행한다. 합성 warm-up 후 각 358개 동일 샘플에 대해 model.predict의 전처리/추론/후처리 시간을 잰다. 모델 로드·디코딩·재생 대기·API 전송은 이 값에 포함하지 않는다. 모델별 한 번의 순차 측정이므로 통계적 속도 보증이 아니다. 실제 재생 속도의 worker→API 전송·유효기간·EOF 검사는 별도 전체 실행의 결과다.

## 결과

수치와 원본 로그 재계산 근거는 [전체 공개 JSON](../../deploy/resource-checks/2026-11-10-ai-alternative-models.json)의 모델별 cases/aggregate/cpu_predict에 있다. TP/FP/FN은 ALARM 메시지 수가 아니라 기존 매칭 규칙으로 묶은 사건 수다.

| 모델 | FIRE TP / FP / FN | SMOKE TP / FP / FN | 정상 FIRE / SMOKE 오탐 | 판단 |
|---|---|---|---|---|
| 기준 rabahdev | 1 / 4 / 0 | 1 / 0 / 1 | 0 / 0 | 기존 결과 재현 |
| luminous | 0 / 1 / 1 | 1 / 14 / 1 | 1 / 14 | 미채택 |
| xiazh | 1 / 1 / 0 | 2 / 1 / 0 | 0 / 0 | 개선된 후속 개발 후보 |

xiazh는 개발 FIRE 정밀도 50%·재현율 100%, SMOKE 정밀도 66.67%·재현율 100%다. 표본은 FIRE 정답 1건·SMOKE 2건으로 작으며 독립 성능 합격 수치가 아니다. 정상 오탐 0은 137.320초 관측 결과다. luminous 정상 오탐을 단순 시간당 환산하면 FIRE 26.22·SMOKE 367.03건이지만 장시간 현장 측정값은 아니다. 기준의 촛불 중복 4건이 xiazh에서는 1건으로 줄었고, 기존 Tai Po 연기 미검출을 검출했으나 새 연기 중복 1건이 있다.

매칭된 경보의 GT 시작 대비 지연은 FIRE 501ms(기준/xiazh), Smoke 0009 500ms(세 모델), Tai Po 2000ms(xiazh)다. 이는 순수 추론 시간과 다르며, 놓친 사건을 지연 평균에서 숨겨 합격으로 처리하지 않는다.

| 모델 | 순수 predict 평균 / p95 / 최대 ms | 샘플링 RSS 최대 MiB | 실제 획득→API 기록 최대 ms | 수락 이벤트 |
|---|---|---|---|---|
| 기준 rabahdev | 22.45 / 28.95 / 39.92 | 657.34 | 538.17 | 365 |
| luminous | 22.91 / 27.62 / 40.39 | 657.66 | 537.37 | 382 |
| xiazh | 136.36 / 155.63 / 179.04 | 860.46 | 546.47 | 365 |

각 모델 358개 샘플·7개 EOF, 세 모델 합계 1074개 샘플·1112개 수락 이벤트다. luminous는 LED 촛불에서 두 종류 ALARM을 함께 내어 이벤트가 17개 더 많다. 21개 실행 모두 전송 payload 일치·제어 로그 PASS, 늦은 샘플 폐기 0·관측 만료 0을 확인했고 자체 제어 프로세스는 종료됐다. RSS는 모델 가중치만의 크기나 연속 관측한 절대 메모리 최댓값이 아니라 프로세스 RSS 샘플의 최대다. xiazh는 검출이 개선된 대신 평균 predict가 기준의 약 6.1배이고 샘플 RSS도 약 203MiB 늘었다.

공개 JSON은 원본 summary/예측/평가/benchmark 로그의 해시, per-case 사건 구간·메시지 개수·검출 샘플 시각과 통계를 담는다. 원본 예측 사건 ID 목록은 해시로 연결된 로컬 평가 로그에 보존한다. 별도 읽기 전용 재계산으로 모델·영상·정답·소스 해시, 실제 전송 payload, 모든 사건 점수, 동일 프레임과 CPU 통계를 다시 대조했다.

## 검출 단절의 구분

- luminous 촛불은 51개 샘플에서 FIRE 박스가 0개다. 이벤트 전달 실패가 아니라 모델 출력 단계의 미검출이다. Tai Po는 11개 중 1개 샘플에서만 SMOKE 박스가 나와 min_detections 2 조건을 충족하지 못했다.
- xiazh 촛불은 51개 중 49개 샘플에서 FIRE를 검출했다. 12012ms·12513ms 두 샘플에 박스가 없고, 13013ms 재검출 시 창 안에서 두 번의 검출 조건을 아직 충족하지 못해 다음 13514ms부터 ALARM이 재개된다. 경보 구간이 501~11512ms, 13514~25025ms로 나뉘어 기존 단일 GT 사건에 TP 1·중복 FP 1로 채점된다.
- xiazh Tai Po는 11개 중 4개 샘플에서 SMOKE를 검출하고 2000ms·5000ms에 ALARM을 전달했다. 첫 구간은 TP, 두 번째는 같은 정답 사건에 대한 중복 FP다. 검출 성공은 확인했지만 지속적인 연기 추적을 완성한 것은 아니다.

이는 로그에서 확인한 **박스→시간 창→사건 분할**의 원인 구분이다. 영상의 실제 불꽃 소실/가림 여부나 기존 주석 오류를 독립 판정한 결과는 아니다. 성능 수치를 좋게 만들려고 GT·매칭 간격·경보 조건을 수정하지 않았다.

## 판단과 남은 범위

luminous는 정상 오탐과 미검출 때문에 개발 기준으로 채택하지 않는다. xiazh는 얇은 연기 검출과 촛불 연속성에서 개선을 확인한 **후속 개발 후보**이며 재현 가능한 별도 설정을 제공한다. 기본 설정은 기존 모델을 유지한다. 개발 7개 결과만으로 최종 모델·서버 적합성·독립 평가 합격을 선언하지 않는다. xiazh의 중복 경보, 짧은 정상 표본, 학습 중복 미확인, 팀 수치 목표/라이선스 합의와 담당 5의 독립 평가가 남는다. 새 후보의 실제 서버 CPU·메모리·전송 검증은 이번 로컬 CPU 비교와 별개다.
