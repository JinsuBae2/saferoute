# A01/A03 개발 정밀도·실행 비용 개선

2026-11-10, #125. #9 선정 모델의 개발 사건 중복과 #114의 서버 지속 실행 폐기3/3641을
개선하는 작업이다. 평가용 영상·구간 정답은 열람하거나 튜닝에 사용하지 않았다.
개발 정답·사건 매칭·confidence0.25·500ms 샘플링·3초 유효기간·늦은 샘플 폐기 기준은 유지한다.

## 수정한 처리

- 검증한 개발 개선 설정은 [입력 크기 제한 OpenVINO 프로필](../../configs/ai.xiazh.clahe.native.development.json)이다.
  기존 xiazh 가중치를 FP32 ONNX로 변환하고 640/500ms/window1500/min2에
  CPU4·Torch 전처리1스레드·`preprocess=clahe`를 지정한다.
  기존 설정에서 새 키를 생략하면 CPU4/명암 보정 없음/ORT CPU로 호환된다.
- 고해상도 프레임은 종횡비를 유지해 최대 변을 imgsz로 줄인 뒤 LAB의 밝기 채널에만
  CLAHE(clipLimit2, 8×8)를 적용한다. 검출 박스는 실제 가로/세로 축소 비율로 원본 좌표에
  복원하며, 원본 미리보기 프레임은 수정하지 않는다. runtime의 `preprocessing_version`은
  `clahe_input_v1`이다. 추적기·과거 검출 재사용을 추가하지 않았다.
- worker는 모든 프레임을 순차 grab하고 시각/개수를 확인하되 예정된 분석 샘플만 retrieve한다.
  픽셀 취득 뒤 시각을 기록하고 기존 lateness 검사를 수행하므로 retrieve 비용도 폐기 판정에
  포함한다. retrieve 실패는 DECODE_FAILED이며 검증된 EOF로 바꾸지 않는다.
  로그 flush/fsync·재전송·관측 유효기간·제어 경보 유지 규칙은 그대로다.

[OpenCV grab/retrieve 문서](https://docs.opencv.org/5.0/main_modules/classcv_1_1VideoCapture.html)와
[CLAHE 문서](https://docs.opencv.org/5.0/javadoc/org/opencv/imgproc/CLAHE.html)의 기존 API를 사용한다.
CPU 스레드는 [PyTorch API](https://docs.pytorch.org/docs/stable/generated/torch.set_num_threads.html)로
고정한다. Ultralytics 첫 predict가 설정하는 스레드를 합성 warm-up 직후 지정 값으로 바꾸고
실제 영상 추론 전에 metadata와 함께 확인한다.

## 개발 정밀도 비교와 미채택 기록

[모든 사전 비교·원본 해시](../../deploy/resource-checks/2026-11-10-ai-precision-screening.json)를
같은 개발7개에서 재계산했다. 처음의 명암 보정은 원본 크기에서 수행했고, 후속 후보는 입력
크기로 먼저 줄여 처리했다. 아래 값은 오프라인 개발 추론이며 실제 전송 결과와 구분한다.

| 후보 | FIRE TP/FP/FN | SMOKE TP/FP/FN | 정상 SMOKE FP | SMOKE 최대 대응 지연 |
|---|---|---|---|---|
| 기존 xiazh0.25, #105 | 1/1/0 | 2/1/0 | 0 | 2000ms |
| 원본 크기 CLAHE | 1/1/0 | 2/0/0 | 0 | 2000ms |
| gamma1.5 | 1/1/0 | 2/2/0 | 1 | 1500ms |
| gamma0.65 | 1/1/0 | 1/0/1 | 0 | 500ms, 미검출1 별도 |
| 입력 크기 CLAHE | 1/1/0 | 2/0/0 | 0 | 2000ms |
| 입력512 CLAHE | 1/1/0 | 1/0/1 | 0 | 500ms, 미검출1 별도 |
| 같은 가중치 ONNX FP32 / CLAHE640 | 1/1/0 | 2/0/0 | 0 | 2000ms |
| ONNX FP32 / CLAHE576 | 1/1/0 | 2/0/0 | 0 | 4500ms |
| INT8 reduced range / CLAHE640 | 1/3/0 | 1/0/1 | 0 | 500ms, 미검출1 별도 |
| OpenVINO FP32 / CLAHE640 | 1/1/0 | 2/0/0 | 0 | 2000ms |
| OpenVINO FP32 / 원본 크기 상한640 | 1/1/0 | 2/0/0 | 0 | 2000ms |

CLAHE의 SMOKE 사건 정밀도는 66.67%(2/3)→100%(2/2), 재현율은 2/2다.
이는 작은 개발 표본이며 **연기의 모든 프레임을 연속 검출하도록 회복한 결과가 아니다.**
후반의 분리된 경보가 추가 사건으로 성립하지 않은 효과를 포함한다. 정상4개는 총137.320초이며
FIRE/SMOKE 오탐0을 현장 장시간 정확도 증명으로 해석하지 않는다.
FIRE는 1/2=50%로 80% 목표 미달이 그대로 남는다.

기존 검출 로그의 confidence0.35 재생은 무개선, 0.50 재생은 연기 첫 대응5000ms로 미채택이다.
이는 새 모델 실행이 아니다. gamma 두 후보는 실제 재추론했지만 오탐/미검출 때문에 제외했다.
불꽃 문제 구간 11011~13514ms의 CLAHE 좌우 반전 진단에서도 12012/12513ms는 미검출이다.
추가 confidence0.05 진단도 두 시각은 미검출이며 13013ms 검출만 회복해 단절을 해결하지 못했다.
이 진단은 전체 성능 평가가 아니며 낮은 임계값이나 반전을 제품 설정에 반영하지 않았다.
개발 원본12012/12513ms 프레임을 육안 확인하면 크게 밝아진 흰 불꽃·촛불 영역이 보인다.
노출/학습 장면 차이는 원인 가설이며 확정하지 않는다. 실제 불꽃 미검출을 정상으로 바꾸거나
정답·사건 매칭을 수정하지 않았다.
512 입력은 TaiPo 연기를 놓쳐 제외했다. ONNX는 기존 가중치를 FP32/dynamic/opset17로 변환하고
개발7개를 실제 재추론한 실행 후보다. ORT2/스핀 대기 비활성으로 사건 집계가 유지됐지만,
V3에서 별도 실행 후보로 연결했다. 아래 실제 전송 결과와 선정 상태를 함께 확인해야 한다.

## 서버 CPU 후보 비교

동일 개발7개에서 고르게 선택한 42프레임을 2회씩, 4→2→1스레드 순서로 실제 추론했다.
모델 로드·픽셀 추출·합성 준비는 predict 시간에서 제외한다. 짧은 순차 비교라 순서·부하의
영향이 남으며 반복적인 독립 속도 보증이 아니다.

| 스레드 | 평균 / p95 / 최대 predict | CPU 시간 / 벽시계 |
|---|---|---|
| 4 | 294.97 / 327.30 / 333.20ms | 99.25 / 25.42초 |
| 2 | 309.21 / 355.90 / 366.56ms | 52.34 / 26.59초 |
| 1 | 542.57 / 605.56 / 626.51ms | 46.19 / 46.20초 |

2스레드는 평균 추론이 약간 느리지만 CPU 시간을 약47% 줄여 지속 실행 후보로 선택했다.
1스레드는 평균500ms를 넘겨 제외했다. 2스레드의 84개 출력 중80개는 4스레드와 완전히 같고
나머지는 좌표/점수의 미세 차이가 있다(최대 스칼라 차이0.00009156). 성능 동일성은 이 비교만으로
선언하지 않고 실제 전체 전송을 별도로 수행했다. CPU 크레딧 지표 조회는 AccessDenied여서
크레딧 고갈을 과거 누락의 확정 원인으로 주장하지 않는다.

## 실제 전송·지속 시험

첫 구현 V1(`3c90a47`)은 원본 크기 CLAHE/CPU2였다. 서버 개발7개는 357/358 분석으로
LED 영상 media3000ms 샘플1개를 폐기했다. 직전2520ms의 read→completion481.06ms,
폐기 lateness599.49ms를 기록했다. 이 값에는 추론 외 처리/대기가 있어 순수 predict로 세지 않는다.
원인 확인 후 V1 지속 시험은 분석930개·폐기10개 시점에 OPERATOR_STOPPED로 중단하고 FAILED 로그와
중단 사유를 보존했다. **30분 통과로 세지 않는다.** 자체 제어기·작업자는 종료됐다.

수정 V2(`7866971`)는 입력 크기 CLAHE와 선택 retrieve를 사용한다. 로컬 원본7개의 모든
358개 예정 샘플에서 read 방식과 grab/retrieve 방식의 BGR 픽셀·시각·프레임 인덱스가 같았다.
이후 grab/retrieve에도 이미 취득한 미리보기 버퍼가 변하지 않음을 358개 샘플에서 확인했다.
실제 OpenCV로 비정방/고해상도/가늘고 긴 합성 이미지4개에서 원본 불변·좌표 역변환도 확인했다.
합성 이미지는 모델 정확도 표본이 아니다.

서버 V2 개발7개는 358/358·폐기0·관측 만료0·EOF/payload/로그 검증을 통과했다.
로컬 원본 입력은 V1 폐기6→V2 폐기1로 줄었으나 원본 AV1 입력의 누락0은 미달이다.
V1 로컬 실행에는 다른 로컬 모델 실험이 겹쳤으므로 시간 개선의 공정한 대조 실험으로 쓰지 않는다.
서버 Smoke0009는 기존에 전체 픽셀/시각 동등성을 확인한 UTVideo 준비 경로를 사용한다.

V2 지속 시험은 1820.160초 입력의 예정3641개 중3521개를 분석하고120개를 늦어서 폐기했다.
관측 만료0, EOF/payload/로그 검증 통과와 별개로 **누락0 성능 기준은 실패**다.
CPU 사용은 준비 구간 이후 약1.5~1.6코어였으며, 별도 한 시점의 시스템 CPU 관측에서
steal7.4%가 있었지만 이것만으로 크레딧 고갈이나 호스트 경합을 확정하지 않는다.
CPU2 설정을 장시간 해결책으로 승인하지 않는다. 후속 실행 후보의 실제 검증 결과를 별도로 기록한다.

OpenMP PASSIVE 대기 후보도 비교했다. 같은 개발 프레임을 500ms 간격으로60회 추론한
4스레드 두 실행의 평균628/456ms, 2스레드 평균623ms로 안정적인 여유가 없어 제외했다.
대조2스레드 기본 대기는480ms였다. 공유 서버 상태·순서에 따른 변동을 포함하는 짧은
진단이며 정확도나 30분 전송을 대신하지 않는다.

## ONNX 실행 후보 V3

동일 `.pt` 가중치의 FP32 ONNX 변환본을 실행한다. V3의2스레드·V4의4스레드 등
미채택 설정은 공개 실행 증거의 `recorded_config`와 검증 소스 tar에 보존했다. 채택 후보에는 학습·양자화·
보정 데이터 사용이 없고 원본 모델의 출처·조건은 그대로다.
변환본 SHA256은 `4163c96eef1ebab77c7f073d0d4001feffda64fbc544f441abf4ca8f4fd69929`다.
추가 실행/변환 패키지는 [별도 lock](../../requirements-ai-onnx.lock.txt)에 고정했다.
공용 서버 가상환경은 수정하지 않고 격리 폴더의 패키지를 사용했다.

고정 Ultralytics8.4.208의 전처리·후처리는 유지하고, 영상 입력 전에 CPU ONNX 세션을
같은 검증 파일로 만들며 내부 스레드2/스핀 대기0을 지정한다. 실제 provider·세션 스레드·
스핀 설정·ORT 버전을 runtime에 남긴다. 첫 라이브러리 준비 이후 해당 세션으로 한 번 더
합성 warm-up을 수행한다. GPU IO binding은 거부한다.
[ONNX 변환 문서](https://docs.ultralytics.com/integrations/onnx/)와
[ORT 스레드 설정](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)을 따른다.

같은 서버 개발 프레임40회 진단에서 기존 PyTorch2의 평균388ms/CPU30.64초에 비해,
ONNX2의 두 실행은 평균320/349ms, CPU24.47/26.42초였다. ONNX1은 평균552ms로 제외했다.
각 실행의 서버 부하가 동일하다는 보장은 없으므로 반복 재현 속도 보증으로 해석하지 않는다.
로컬 개발7개 오프라인의 사건 종류·media_time_ms는 PyTorch CLAHE와 모두 같았으며,
박스/점수의 비트 단위 동일성이나 독립 정확도 동일성을 주장하지 않는다.

V3(`18153c7`) 로컬 실제 전송은 원본 AV1을 포함해358/358·폐기0·관측 만료0,
EOF/payload/로그 통과다. 이 실행 중 일반 회귀 검사가 일부 겹쳐 순수 추론 속도 비교로는 쓰지 않는다.
서버 V3 개발7개는358/358·폐기0·관측 만료0·EOF/payload/로그 통과지만 지속 실행에서
분석682개·폐기13개를 기록해 중단했다. V3은 전송 중 중단돼 terminal 관측이 없으며
요약의 관측 만료 수도 없다. 이를0이나 EOF 통과로 바꾸지 않는다.

후속 V4(`a4f53a3`)는 ORT4/Torch 전처리1로 분리했다. 개발7개는358/358·폐기0·
관측 만료0이지만 지속 분석2086개·폐기12개로 중단했다. V1/V3/V4는30분 통과가 아니다.

## OpenVINO FP32 실행 후보 V5

ORT4/Torch1의 짧은 서버 진단은 평균323/308ms였다. OpenVINO 기본 HT 정책에서
4스레드 요청은 평균385/344ms였고, HT를 명시한4스레드는 평균277/282ms·최대312/305ms였다.
모두 같은 개발 프레임40회, 500ms 간격의 순차 진단이며 공유 서버 부하/순서의 영향을 포함한다.
짧은 진단만으로 지속 성능을 승인하지 않고 V5(`cf62919`)의 실제 전송으로 연결했다.

[고정 plugin lock](../../requirements-ai-openvino.lock.txt)을 사용한다.
[공식 plugin API](https://github.com/onnxruntime/onnxruntime-ep-openvino/blob/main/docs/QuickStart.md)로
CPU 장치를 정확히 하나 선택하고 FP32/LATENCY/1 stream/4 threads/HT 사용을 요청한다.
[OpenVINO CPU 설정](https://docs.openvino.ai/2026/openvino-workflow/running-inference/inference-devices-and-modes/cpu-device/performance-hint-and-thread-scheduling.html)에
따른 요청이며 실제 provider·ORT/plugin 버전·요청 옵션을 runtime에 남긴다. GPU IO binding,
CPU 장치 누락, provider 미활성은 실패 처리한다. 세션 전체의 자동 재시도 fallback을 끈다.
연산별 ORT CPU fallback은 허용하므로 provider 목록만으로 모든 노드의 OpenVINO 실행을
주장하지 않는다. Torch 전처리는1스레드, ORT fallback도1스레드다.

V5 로컬 원본 AV1 포함7개는358/358·폐기0·관측 만료0·EOF/payload/로그 통과다.
서버 개발7개도 같은 결과지만 지속 시험은 예정3641개 중3638개 분석·폐기3개로
누락0 기준에 실패했다. 관측 만료0·EOF/payload/로그 통과와 별개다.
시험 종료 후 별도 개발 프레임1개의 ORT profiling에서 OpenVINO provider의 실제
노드 실행을 확인했다. 이 진단은 속도·정확도 평가가 아니다.

미채택 기록: ONNX576은 연기 첫 대응4500ms로 제외했다. INT8은 개발7개에서 균등42프레임을
정답 라벨 없이 보정했다. full range 변환본은 서버에 VNNI 플래그가 없어 추론하지 않았고,
reduced range 실제7개는 불꽃 FP3·연기 FN1로 제외했다. 최종 FP32 후보에는 양자화를 적용하지 않았다.
밝기 감소·중앙 패딩 불꽃 진단도12012/12513ms 단절을 해결하지 못해 채택하지 않았다.

첫 OpenVINO 오프라인 시도는 Windows `ep_metadata` 디코딩 오류로 영상 추론 전에 실패했다.
typed CPU device API로 수정한 별도 실행은7개를 완료했다. 이 사전 실험의 metadata에서
`onnx_runtime`은 초기 세션, `openvino_probe`는 실제 교체 세션이다. 원본을 고쳐 쓰지 않았고
제품 V5는 실제 세션을 `onnx_runtime`에 직접 기록한다.

## 저해상도 확대 비용 제한 V6

V5 지속 실행에서 media982520/983520/985000ms 샘플을 폐기했다. 직전 프레임의
취득→완료는 약783/753/641ms였으며 순수 추론 시간으로 단정하지 않는다.
기존 작은 CAVIAR 원본384×288도640×480으로 확대해 처리하고 있었다.
V6(`ace44da`)의 `native_input_size=true`는 입력의 최대 변을32배수로 올림하되
config.imgsz 상한을 유지한다(최소32). 따라서384×288은384, 500폭은512,
640 이상 원본은 기존640을 사용한다. 모델에 넣기 직전 크기 선택이며 검출 박스는
Ultralytics와 CLAHE 역변환을 거쳐 원본 좌표를 유지한다.
고정 xiazh 모델의32 stride에 맞춘 정책이며 특정 영상 ID나 정답에 따른 분기가 아니다.
기본값false는 기존 고정 imgsz 동작이다. 샘플링/유효기간/폐기 기준은 바꾸지 않는다.

사전7개 실제 재추론은 위 표와 같고 정상 오탐0·연기 지연2000/500ms를 유지했다.
로컬 CAVIAR3개의 평균 predict는 약50ms였지만 이를 서버 속도로 주장하지 않는다.
이 실험은 private override를 `native_size_probe`에 기록했으며 제품 V6의 명시 설정으로
실제 전송을 별도 검증했다. V6 로컬 원본7개와 서버7개 모두358/358·폐기0·관측 만료0·
EOF/payload/로그 검증을 통과했다. 서버1820.160초 반복 입력은 **3641/3641 분석·폐기0·
관측 만료0·정상 경보0**으로 완료했다. 실제 worker 처리1820.317초, 송신/수신3642개
(EOF 포함)의 payload 일치와 종료 로그 무결성을 대조했다. 이 단일 개발 실행의 기준 통과다.

동일 반복 입력의 준비 이후 worker CPU는 V5 약2.22코어→V6 약0.84코어였다.
RSS 최댓값은 약743.54→752.86MiB로 약간 늘었다. 순차 실행의 부하 차이를 포함하므로
독립된 반복 속도/메모리 보증으로 해석하지 않는다. 종료 후 별도 원본 개발 프레임1개에서
V6의 OpenVINO 노드 실제 실행도 profiling으로 확인했다.
저해상도 입력에서 비용을 줄이는 정책이므로 고해상도 카메라나 모든 화재 장면의
30분 성능을 증명하지 않는다.

[실행별 원본 해시·실패·집계](../../deploy/resource-checks/2026-11-10-ai-runtime-improvement.json)에
위 결과를 보존한다. 집계할 때 현재 parser의 기본값 정규화를 대조하고 `recorded_config`에
당시 원본 설정을 남긴다. 반복되는 probe 설정·runtime은 해시 참조로 모아 기록한다.
probe 각 행은 그룹의 `recorded_common`과 합쳐 읽는다.
표 형식의 영상별 요약 행은 `case_table_columns` 순서이며 수치·원본 로그 해시를
유지한다. 사전 비교 설정/runtime은 `experiment_common_*`와 각 후보의 `*_overrides`를
합쳐 원래 값을 복원한다. 공통 항목을 모은 것이며 실패 후보를 생략한 것이 아니다.

## 재현·남은 범위

고정 AI 환경과 개발7개 manifest를 준비하고 `tools.validate_ai_delivery`에 명암 보정 프로필,
전체7개 asset_id, 새 출력 폴더를 지정한다. 지속 시험은 #114와 동일한 1820.160초 반복 개발
입력·별도 manifest 및 `--worker-timeout-seconds 2100`을 사용한다. 원본/파생 해시·모델 해시를
확인하고 실행 중 다른 성능 실험을 같은 서버에서 병렬 실행하지 않는다.

V5는 기존 AI 환경에 ONNX·OpenVINO lock의 패키지가 필요하다. 기존 xiazh `.pt` 파일의 해시를
먼저 확인한 다음 고정 Ultralytics에서 다음 인자로 변환한다.

```python
from ultralytics import YOLO

YOLO("models/xiazh-fire-smoke-yolo26m.pt").export(
    format="onnx", imgsz=640, dynamic=True, simplify=False, opset=17,
    device="cpu", batch=1, nms=False,
)
```

시험한 변환본은 지원 서버의 격리 검증 경로
`/home/ubuntu/saferoute-validation-a01-81/onnx-probe-125/model.onnx`에도 보존했다.
복사한 파일은 해당 ONNX 설정의 해시와 대조한다. 새로 export하면 생성 metadata/환경 차이로
바이트 해시가 달라질 수 있다. 이 경우 테스트한 파일과 동일하다고 간주하지 않고
원본·파생 해시·변환 환경을 기록한 별도 `.local.json` 설정에서 개발/지속 검증을 다시 수행한다.
영상·가중치·실행 원본은 Git에 넣지 않는다.
V6 검증 소스 tar는 지원 서버의 같은 격리 상위 경로 `a01-125-v6-source.tar`에 보존하고
공개 실행 증거의 SHA256으로 대조한다. develop 동기화 후에도 최종 AI/backend/tools 파일이
실제 V6 실행 소스와 바이트 단위로 같은지(줄바꿈 정규화) 검증한다.

FIRE 중복1건과 여러 카메라/외부 네트워크/WFI 상시 배포는 남는다.
#12 최종 입력 동결·#30 독립 평가/담당5 대조·#41 설명 독립 검수를 대신 완료 처리하지 않는다.
과거 실패와 미채택 후보를 숨기거나 이미 승인한 정밀도/재현율/지연/폐기 기준을 완화하지 않는다.
