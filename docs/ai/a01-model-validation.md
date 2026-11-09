# A01 로컬 실행 검증 — 2026-11-09

관련 이슈: [A01 #9](https://github.com/JinsuBae2/saferoute/issues/9). 담당: Rinhaze / 1번.
완료된 도구·개발 자료는 [A01-1 #79](https://github.com/JinsuBae2/saferoute/issues/79)로 인계한다. 아래 최초 실행 수치는 당시 기록이며, A02 이벤트 연결·A03-1 장애 처리·A04-1 집계 도구는 현재 develop에 별도로 반영되어 있다.
후속 입력 크기 비교·재생 속도 측정·사용 조건·서버 인계는 [후속 검증 기록](a01-selection-and-server-check.md)에 정리했다.
최초 실험 기준 develop: `5a0c169393cb4a7e80be4600a6cd980a864eb251`.
PR 준비 시 최신 develop `fe5bbabf1692f48771f1a232bd10b31595f6c034`를 반영하고 공통 검사를 다시 실행했다.
검토 지적 보완 시 develop `77a5298`의 팀 작업을 추가 반영했다.
정상·혼동 장면 추가 검증 시 develop `08614a3`까지 반영했다.

**실제 CPU 추론과 불꽃·연기 클래스 출력을 확인했다. 최종 모델 선정과 A01 전체 완료 판정은 보류한다.**
5번의 자료 인계를 기다리지 않고 공개 개발 영상 4개를 확보했고, 후속 검증에서 정상 통로·수증기 후보 2개를 추가해 총 6개가 됐다. 얇은 연기 미검출과 축소 입력에서의 오탐·미탐을 발견했다. 이번 도구는 오프라인 실행 검증용이며 A02 이벤트/API 연동, A03 설정 확정, A04 독립 평가를 구현한 것이 아니다.

## 출처와 환경

| 항목 | 확인 내용 |
| --- | --- |
| 모델 | [rabahdev/fire-smoke-yolov8n](https://huggingface.co/rabahdev/fire-smoke-yolov8n), YOLOv8n D-Fire 추가 학습이라는 배포자 설명 |
| revision | `13017fe8af477c25f5298d168e2dfede4b000753` |
| 파일 | 원본 best.pt → models/fire-smoke-yolov8n.pt, 6,229,802 bytes |
| SHA-256 | `b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f`, 배포 API LFS 해시와 일치 |
| 실제 클래스 | 0=smoke, 1=fire |
| 코드·가중치 조건 | Ultralytics 설치 메타데이터와 모델 카드 각각 AGPL-3.0 표기. 제출·배포 범위에 대한 적용 정리는 남은 작업 |
| 학습 데이터 | [D-Fire LICENSE](https://github.com/gaia-solutions-on-demand/DFireDataset/blob/master/LICENSE)는 수집물 CC0 및 개별 이미지 저작권 미소유를 명시. 개별 권리·학습 장면 중복은 별도 검증하지 않았으며 학습 자료를 다운로드하지 않음 |
| 환경 | Windows 10 build 19045 x86_64, Python 3.12.16, CPU 전용 추론 |
| CPU | Intel64 Family 6 Model 183 Stepping 1, GenuineIntel / 논리 CPU 16개, 추론 스레드 4개. 상품명 미확인 |
| GPU | RTX 3060 Ti 8 GiB 확인. 이번 추론에 사용하지 않음 |
| 주요 패키지 | torch 2.15.0+cpu, torchvision 0.29.2+cpu, ultralytics 8.4.208, opencv-python 5.0.0.93, numpy 2.5.4, psutil 7.2.2 |

전체 39개 패키지는 [requirements-ai.lock.txt](../../requirements-ai.lock.txt)에 고정했다. Windows 실측이며 Linux 서버 검증을 대신하지 않는다. 모델 카드 성능 수치는 우리 결과로 사용하지 않는다. 코드·가중치·데이터의 조건은 각각 기록한다. 가중치·영상·프레임·실행 로그는 Git에서 제외한다.

## 개발 영상

정확한 다운로드 URL·해시·원본 장면 ID는 [assets.json](../../data/manifests/assets.json)에 있다. 모두 development이며 독립 정답 파일·주석자·검토자·건물 구역 매핑은 아직 없다.

영상별 `read_validation`에는 FPS·해상도·코덱·실제 디코딩 수·마지막 영상 시각과 근거 파일의 경로·해시·실행 시각을 기록했다. 최초 4개는 기존 640 실행 summary, 추가 2개는 `runs/a01-negative-probe/probe.json`의 순차 디코딩 기록에서 가져왔고 후속 추론 결과와 대조했다. `read_success=true`는 프레임을 읽고 증가하는 시각을 확인했다는 뜻이며 정상 EOF나 전체 영상의 무손상 판정은 아니다. `source_duration_s`는 출처의 길이, `last_decoded_media_time_ms`는 실제 마지막 프레임 시각이므로 구분한다. `reported_fps`와 `reported_frame_count`는 컨테이너 보고값을 그대로 보존하며 특히 LED 영상의 1000 FPS를 실제 재생률로 사용하지 않는다. 로컬 근거 파일은 Git에서 제외하지만 재실행으로 메타데이터를 대조할 수 있다.

| ID | 출처·저작자 | 선택한 조건 | 용도 |
| --- | --- | --- | --- |
| dev-flameless-candle | [Flameless candle 1](https://commons.wikimedia.org/wiki/File:Flameless_candle_1.webm), Bastenbas / Elfix | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 실제 불꽃 없는 LED 촛불 |
| dev-candle-match | [Candle and Match](https://commons.wikimedia.org/wiki/File:Candle_and_Match.ogv), LoKiLeCh | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) | 촛불·성냥 근접 슬로모션 |
| dev-joss-smoke | [Joss paper burning](https://commons.wikimedia.org/wiki/File:Joss_paper_burning_with_cloud_of_smoke_Tai_Po_HK_2026.webm), Waydwaid | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 가림이 있는 야외 연기 |
| dev-smoke-0009 | [Smoke 0009](https://commons.wikimedia.org/wiki/File:Smoke_0009.webm), Amuzujoe | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | 짙은 야외 연기. 첫 미검출 후 추가한 개발 자료 |
| dev-metro-ermita-corridor | [Metro Ermita 통로](https://commons.wikimedia.org/wiki/File:Transbordo_de_la_l%C3%ADnea_2_y_12_de_Metro_Ermita.webm), ProtoplasmaKid | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | 보행자·조명·바닥 반사가 있는 정상 실내 후보 |
| dev-chemical-plant-steam | [Steam from a chemical plant](https://commons.wikimedia.org/wiki/File:Steam_from_a_chemical_plant.webm), 驭龙飞车手 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 출처에서 수증기로 소개한 야외 혼동 후보 |

다운로드한 원본 바이트는 수정하지 않았다. 로컬 미리보기는 프레임 추출·축소·시각/박스 표시를 한 파생물이다. 공유 시 저작자·원본·라이선스·변경 사실을 함께 표시하고 SA 조건을 유지한다. 통로 영상에는 저작자 요청 표기 `ProtoplasmaKid / Wikimedia Commons / CC-BY-SA 4.0`을 사용한다. 이 원본 장면 및 파생물은 독립 평가에서 제외한다. 5번에게 인계할 manifest를 준비했으며 별도로 전송하지 않았다. 정상 실내 고정 CCTV, 실내 수증기와 다양한 방해 장면은 아직 부족하다. 기존 4개 영상 전달 ZIP에는 추가 2개가 들어 있지 않다.

## 실측 결과

confidence=0.25, CPU 스레드=4. A는 imgsz=640 / 영상 시각 500ms 간격, B는 imgsz=320 / 1000ms 간격이다. 두 변수를 함께 바꾼 탐색 비교이므로 단독 효과를 단정하지 않는다. imgsz는 최대 변 길이이며 패딩은 Ultralytics에 따른다. 합성 검정 프레임 예열 1회는 영상 결과에서 제외했다.

아래 수치는 **검출이 있었던 샘플 프레임 수 / 처리한 샘플 프레임 수**이며 정확도·재현율·사건 수가 아니다.

| 영상 | A FIRE | A SMOKE | B FIRE | B SMOKE |
| --- | --- | --- | --- | --- |
| LED 촛불 | 0 / 18 | 0 / 18 | 9 / 9 | 0 / 9 |
| 촛불·성냥 | 16 / 51 | 0 / 51 | 0 / 26 | 0 / 26 |
| Tai Po 연기 | 0 / 11 | 0 / 11 | 0 / 6 | 0 / 6 |
| Smoke 0009 | 0 / 20 | 20 / 20 | 0 / 10 | 10 / 10 |

| 영상 | A 평균 / p95 predict ms | B 평균 / p95 predict ms | A 전체 처리초 / 샘플 처리량 fps | A 샘플 시점 최대 RSS MiB |
| --- | --- | --- | --- | --- |
| LED 촛불 | 22.39 / 44.22 | 11.87 / 21.18 | 1.15 / 15.62 | 447.82 |
| 촛불·성냥 | 23.66 / 27.58 | 11.73 / 13.95 | 1.38 / 36.96 | 422.84 |
| Tai Po 연기 | 23.84 / 32.89 | 13.24 / 18.76 | 0.64 / 17.10 | 450.74 |
| Smoke 0009 | 23.74 / 28.15 | 11.32 / 14.65 | 7.78 / 2.57 | 635.00 |

predict 시간은 전처리·추론·후처리 호출 경과시간이다. 전체 시간은 순차 디코딩·샘플 추론·로그·첫 프레임 저장을 포함한다. RSS는 추론 직후 프로세스 전체 측정값으로 순간 최고치나 모델 단독 메모리가 아니다. p95는 작은 표본의 nearest-rank다. 로드 약 0.02~0.03초, 예열 약 1.55~1.62초이며 패키지 import는 제외한다. 실시간 재생/API 지연·반복 분산은 미측정이다.

위 기존 실행에서 CPU 스레드 4개는 **예열 이후 영상 추론**에 적용한 값이다. 예열 스레드는 당시 별도 기록하지 않았으므로 예열 시간까지 4개 스레드 조건으로 해석하지 않는다. 수정 도구는 `synthetic_warmup_torch_threads_before/after`로 예열 호출 전후 값을 각각 기록하고, 영상 처리의 `torch_threads`와 구분한다. 첫 predict 안에서 Ultralytics가 CPU 스레드를 바꿀 수 있으므로 두 값은 예열 전체에서 스레드 수가 일정했다는 뜻은 아니다. 기존 결과 파일은 소급 수정하지 않았다.

수정 후 2026-11-09 05:01 UTC의 `runs/a01-review-fix-640/summary.json`에서 예열 전 10개·예열 후 8개·영상 추론 4개를 확인했다(예열 1.760초). 원본 해시를 확인하고 영상 4개를 다시 순차 처리했으며 manifest의 메타데이터·디코딩 프레임 수·마지막 시각·종료 상태가 모두 일치했다. 기존 근거 summary의 해시도 대조했다. 검출 프레임 수는 A와 같았으며 이 재실행은 정확도 평가가 아니다.

로컬 근거는 `runs/a01-cpu-640-final/`, `runs/a01-cpu-320-final/`의 summary.json과 영상별 JSONL이다. final은 보고서에 사용한 실행 이름이며 모델 확정을 뜻하지 않는다. 초기 3개 영상 실행도 `runs/a01-cpu-640/`에 보존했다.

### 발견한 문제

- Tai Po 연기는 두 설정 모두 미검출. 가림·대상 크기·화질은 가능한 원인이지만 검증된 원인은 아니다.
- 320 설정은 LED를 불꽃으로 검출하면서 실제 촛불을 놓쳤다. 속도만으로 입력 크기를 선택할 수 없다.
- AV1 Smoke 0009는 모델 호출에 비해 전체 영상 처리가 느렸다. 디코딩 영향이 의심되지만 별도 프로파일링은 아직 없다.
- LED WebM은 OpenCV에서 FPS=1000, 프레임 수=8683으로 보고하지만 실제 217프레임, 마지막 시각 8640ms였다. 따라서 도구는 FPS 기반 seek 대신 순차 디코딩한 media timestamp로 샘플링한다.
- 촛불 OGV도 보고 763 / 실제 읽기 761프레임이다. 이 오프라인 도구의 OpenCV read=False는 정상 EOF와 손상을 구별하지 못하므로 읽기 종료로 기록한다. 현재 실제 관측 worker의 종료·디코드 실패·관측 불가 처리는 별도 [A03-1 기록](a03-input-failures.md)을 따른다.

## 재실행과 사용자 확인

### 추가 정상·혼동 장면 검증

`runs/a01-expanded-640/`에서 총 6개를 동일한 후보·confidence=0.25·imgsz=640·500ms 간격·영상 추론 4스레드로 실행했다. 새 자료에 맞춰 임계값을 조정하지 않았다. 처음 4개의 검출 프레임 수는 기존 A와 일치했다. 새 영상의 원본 해시·출처 페이지 revision·사용 조건도 manifest에 기록했다.

| 추가 영상 | FIRE / 샘플 | SMOKE / 샘플 | 평균 / p95 predict ms | 전체 처리초 / 샘플 처리량 fps | 샘플 시점 최대 RSS MiB |
| --- | --- | --- | --- | --- | --- |
| 실내 통로 | 0 / 25 | 0 / 25 | 24.65 / 30.09 | 9.58 / 2.61 | 635.55 |
| 수증기 후보 | 0 / 19 | 7 / 19 | 22.23 / 31.73 | 1.31 / 14.48 | 478.83 |

두 영상의 500ms 간격 contact sheet를 확인했다. 통로는 보행자와 조명·바닥 반사가 보이며 확인한 샘플에 불꽃·연기가 보이지 않았다. 이동 카메라 1개 장면이며 WFI나 고정 CCTV의 정상 분포를 대표하지 않는다. 수증기 후보는 출처 설명에 근거한 분류이며 물질 성분·연소 여부를 독립 확인한 정답이 아니다. 따라서 7/19를 확정 오탐률로 부르지 않고 **연기와 혼동할 가능성이 있는 개발 사례**로 남긴다. 독립 정답 주석은 두 영상 모두 없다.

통로는 367프레임·마지막 시각 12,212ms를 읽었다. 수증기 후보는 컨테이너 보고 289프레임과 실제 읽기 267프레임이 다르고 마지막 시각은 9,359ms다. 영상 종료·손상 여부는 확정하지 않으며 읽힌 구간의 결과로만 해석한다. 추론 환경은 기존 AI lock 그대로이며 `opencv_version`은 최초 4개에서 배포 패키지 버전, 추가 probe에서는 OpenCV의 `cv2.__version__` 보고값이다.

추가 자료로 정상·혼동 장면의 부족을 일부 보완했지만, 기존 얇은 연기 미검출과 신규 혼동 결과 때문에 최종 모델 선정은 계속 보류한다. 다음 판단에는 비교 후보 또는 개선 설정 검증, 최종 서버에서의 3초 관측 유효기간 확인이 필요하다.

후속 코드 검토에서 입력 경계도 보완했다. 같은 영상 시각의 반복 프레임은 추론을 건너뛰고 `skipped_duplicate_timestamp_frames`에 집계하며, 음수·비유한 값·시각 역행은 실패 처리한다. 기본 manifest는 실행 위치와 무관하게 저장소 기준으로 읽고, 명시한 상대 manifest와 출력 경로는 현재 작업 디렉터리 기준이다. 대소문자만 다른 ID를 포함한 중복 asset_id는 모델 로딩과 출력 폴더 생성 전에 거부한다. 이 동작의 단위 시험과 `runs/a01-expanded-regression-640/`의 실제 6개 재실행을 확인했다. 모든 영상의 읽기 메타데이터·검출 프레임 수가 위 실행과 같았고, 해당 6개에서 반복 시각 건너뛰기는 0건이었다. 새 반복 시각 처리 자체는 모의 입력 단위 시험으로 확인했으며 실제 반복 PTS 영상 시험은 아니다.

### 실행 명령

저장소 루트에서 실행한다. 이 PC의 `.venv-ai`와 원본 파일은 준비되어 있다. 결과를 보존하려고 **새 출력 폴더 이름**을 요구한다.

```powershell
.venv-ai\Scripts\python.exe -m tools.validate_ai_model --output runs/a01-user-check
```

출력 폴더의 dev-candle-match-first.jpg, dev-joss-smoke-first.jpg, dev-smoke-0009-first.jpg와 summary.json을 열어 확인한다. 첫 프레임 미리보기는 전체 검출을 대표하지 않는다. 전체 결과는 해당 영상 JSONL의 시각·박스·점수를 확인한다. B 설정은 `--imgsz 320 --interval-ms 1000`과 다른 출력 폴더를 사용한다.

새 Windows 환경에서는 Python 3.12 / uv를 준비하고 다음을 실행한다. [PyTorch 공식 설치](https://pytorch.org/get-started/locally/) 및 [Ultralytics 공식 설치](https://docs.ultralytics.com/quickstart/)를 참고했다.

```powershell
uv venv --python 3.12 --managed-python .venv-ai
uv pip install --python .venv-ai\Scripts\python.exe --index-strategy unsafe-best-match -r requirements-ai.lock.txt
New-Item -ItemType Directory -Force models,data/videos | Out-Null
$manifest = Get-Content data/manifests/assets.json -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($asset in @($manifest.model) + @($manifest.videos)) {
    if (Test-Path -LiteralPath $asset.path) { continue }
    curl.exe -L --fail --retry 2 --output $asset.path $asset.download_url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $($asset.path)" }
}
```

이번 PC의 uv는 저장소 상위 `tmp/ai-tools/uv.exe`에 있으며 캐시·관리 Python도 같은 도구 폴더에 두었다. 코어 `.venv`와 AI `.venv-ai`는 분리했다. 도구는 파일 누락·해시 불일치·클래스 불일치·영상 열기 실패·시각 역행을 실패로 처리하며 모의 결과로 대체하지 않는다.

## 검사와 남은 작업

A01-1 #79 인계 시 최신 develop `fc1fa4a` 위에서 기본 640/500ms/0.25 조건으로 실제 6개 원본을 재실행했다. `runs/a01-handoff-79-640/summary.json`의 SHA-256은 `8c3ebbd1af8b7cfc5ac2efe23024021b3f33cd37fb71e9086f4e5b621f118b26`이다. 영상·가중치 해시 검사가 통과했고, 6개 모두 이전 `a01-expanded-regression-640`의 디코딩 수·마지막 시각·샘플 수·클래스별 검출 프레임 수와 일치했다. 이번 실행은 `--pace` 없는 오프라인 재현이며 과거 처리시간 수치를 새 측정값으로 덮어쓰지 않았다. WFI v3 연결 예시의 source/zone과 필수 관측원 12개는 현재 Building·AIConfig 검사로 별도 대조했다. 실제 WFI 통합·독립 성능 평가는 아니다.

- 최초 코어 검사: PYTHONUTF8=1로 pytest **206개 통과**, 계약 산출물 일치. 당시 CP949 읽기 오류는 실행 환경 UTF-8 설정으로 해결했다.
- PR 준비 검사: 최신 develop의 Windows UTF-8 수정과 팀원 작업 반영 후, CI와 동일한 `-X warn_default_encoding -W error::EncodingWarning` 조건으로 pytest **299개**, 협업 검사 unittest **15개**, 계약 산출물 검사를 통과했다. Node **24.22.2**에서 `npm ci --ignore-scripts` 및 `npm run test:contracts`도 통과했다. 기존 Starlette httpx 사용 중단 예정 경고 1건이 있으며 실패는 아니다.
- AI lock 오프라인 설치 dry-run: 39개 설치 패키지 일치, 변경 없음.
- 새 단위 시험은 프레임별 중복 박스 집계·미검출 포함·빈 실행 거부·누락/변조 파일 거부를 검사한다. 실제 추론은 별도 로컬 실행으로 확인했다. CI 모델 다운로드는 추가하지 않았다.
- A01 남은 항목: 고정 CCTV·실내 수증기 등 대표 정상/방해 장면 보강, 미검출·혼동을 고려한 후보 선정, 제출 조건 정리, 최종 장비 재측정. 독립 평가·이벤트 연동·Bedrock은 다음 작업이다.
- 공유 방식: 기존 Draft PR #47의 완료된 검증 자료를 #79에서 최신 develop에 인계한다. 최종 모델 선정·팀 라이선스 결정·지원 서버 실측은 상위 #9에 유지한다. 인계 완료를 모델 선정 완료나 독립 평가 통과로 해석하지 않는다.
