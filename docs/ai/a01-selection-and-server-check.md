# A01 후보 판단·사용 조건·서버 검증 인계

관련 이슈: [#9](https://github.com/JinsuBae2/saferoute/issues/9). 2026-11-09, 조대성 / Rinhaze.

**개발 기준 후보는 rabahdev/fire-smoke-yolov8n의 640 / 500ms / confidence 0.25를 유지한다. 최종 채택은 서버 실측과 팀 라이선스 결정 전까지 보류한다.** 기존 자료·환경은 [실행 기록](a01-model-validation.md), 원본 해시는 [manifest](../../data/manifests/assets.json)에 있다. 이 문서는 A01 판단 근거이며 A02 이벤트 전송이나 A04 독립 평가를 구현하지 않는다.

## 1. 같은 개발 영상에서 입력 크기 비교

`runs/a01-selection-960/`에서 960 / 500ms / 0.25 / CPU 4스레드를 실제 실행했다. 640 기준은 `runs/a01-expanded-regression-640/`이다. 입력 크기만 바꾸었으며 같은 6개 원본·동일 가중치를 사용했다.

| 영상 | 640 FIRE / SMOKE | 960 FIRE / SMOKE | 샘플 수 |
| --- | --- | --- | --- |
| LED 촛불 | 0 / 0 | 0 / 1 | 18 |
| 촛불·성냥 | 16 / 0 | 48 / 0 | 51 |
| Tai Po 연기 | 0 / 0 | 0 / 0 | 11 |
| Smoke 0009 | 0 / 20 | 0 / 20 | 20 |
| 실내 통로 | 0 / 0 | 0 / 3 | 25 |
| 수증기 후보 | 0 / 7 | 0 / 4 | 19 |

수치는 검출이 있었던 샘플 프레임 수이며 정확도·재현율이 아니다. 수증기는 출처 설명에 따른 혼동 후보이고 확정 음성 정답이 아니다. 960의 영상별 평균 predict는 39.48~47.18ms였다. 촛불 검출은 늘었지만 LED·통로에 연기 검출이 추가됐고 기존 Tai Po 미검출도 해결되지 않았다. 그래서 입력 크기 증가만을 근거로 960을 채택하지 않는다. 기존 320 결과도 LED 불꽃 검출 9/9 및 촛불 미검출 때문에 기본값에서 제외한다.

비교 후보 [pedbrgs/Fire-Detection](https://github.com/pedbrgs/Fire-Detection/tree/9d99b0e71fd4cc930da053a41b79de1c58aabdf2)은 소스·README를 확인했다. [Dockerfile](https://github.com/pedbrgs/Fire-Detection/blob/9d99b0e71fd4cc930da053a41b79de1c58aabdf2/Dockerfile)은 Python 3.8, [requirements](https://github.com/pedbrgs/Fire-Detection/blob/9d99b0e71fd4cc930da053a41b79de1c58aabdf2/requirements.txt)는 torch 1.10.1·tensorflow 2.6.2 등으로 고정돼 있다. 현재 Python 3.12 환경과 같은 환경으로 실행 가능한 후보라고 취급하지 않는다. 저장소 최상위 MIT 표기만으로 외부 가중치·기반 YOLOv5 코드까지 MIT라고 판단하지 않는다. 별도 환경 구축·외부 가중치 조건 확인·실제 추론은 수행하지 않았으며, 성능이 낮아서 탈락시킨 것이 아니다. 이번에 검증한 실행 후보는 YOLOv8n 하나다.

## 2. 원래 영상 시각에 맞춘 로컬 처리 측정

실행 명령:

```powershell
.venv-ai\Scripts\python.exe -m tools.validate_ai_model --output runs/a01-paced-640 --pace
```

`--pace`는 각 영상의 처리 시작 단조 시계에 media timestamp를 대응시켜 샘플 추론 시각까지 기다린다. 비샘플 프레임은 순차 디코딩하며, 느려져도 샘플을 자동 폐기하지 않는다. 지연이 누적되면 그대로 수치에 드러난다. 라이브 카메라 입력이나 A02의 오래된 프레임 폐기 정책은 아니다.

| 영상 | 읽기 완료→추론 완료 최대 ms | 연속 샘플 추론 완료 간격 최대 ms | 예정 영상 시각 대비 완료 지연 최대 ms |
| --- | --- | --- | --- |
| LED 촛불 | 486.38 | 523.98 | 70.05 |
| 촛불·성냥 | 520.58 | 524.05 | 55.14 |
| Tai Po 연기 | 477.33 | 512.68 | 46.11 |
| Smoke 0009 | 227.21 | 518.44 | 87.36 |
| 실내 통로 | 301.40 | 532.09 | 93.63 |
| 수증기 후보 | 471.67 | 517.50 | 52.92 |

근거는 `runs/a01-paced-640/summary.json`과 영상별 JSONL이다. `frame_read_completed_at`과 `analysis_completed_at`은 UTC이고, 경과시간·간격은 단조 시계로 측정한다. 읽기 완료→추론 완료에는 재생 시각을 기다린 시간도 포함한다. 첫 샘플에는 이전 완료 시각이 없으므로 간격이 null이다. 전체 파일 처리 시간 필드는 호환성을 위해 `offline_elapsed_s`를 유지하며 `paced_playback=true`인 실행은 기다린 시간도 포함한다.

6개 영상에서 최대 완료 간격은 532.09ms, 최대 읽기 후 경과는 520.58ms였다. **이 PC에서 측정한 추론 구성요소의 결과일 뿐 서버의 3초 관측 유효기간 통과 판정이 아니다.** 모델 로딩·예열·VideoCapture 열기, 첫 샘플 이전 공백, EOF 뒤 공백, 네트워크·API 수신·백엔드 판단 지연은 이 간격에 포함되지 않는다. 실제 VIDEO_AI 유효성 확인은 A02 연결 후 별도 대조한다. 빠른 처리·느린 처리의 지연 계측은 가짜 시계 단위 시험으로도 확인했다.

## 3. 사용 조건과 제출 범위

| 구분 | 확인한 근거 | 이번 처리·남은 확인 |
| --- | --- | --- |
| 가중치 | [고정 revision 모델 카드](https://huggingface.co/rabahdev/fire-smoke-yolov8n/blob/13017fe8af477c25f5298d168e2dfede4b000753/README.md)의 AGPL-3.0 | 해시·출처 기록, Git에 가중치 미포함. 최종 공개/배포 조건은 팀 결정과 대조 |
| 실행 코드 | 설치된 ultralytics 8.4.208 메타데이터 AGPL-3.0, [공급자 라이선스 안내](https://www.ultralytics.com/license) | 공급자는 AGPL 방식의 프로젝트 공개 또는 Enterprise 조건을 안내한다. 공개 저장소라는 사실만으로 모든 조건이 충족됐다고 표시하지 않음 |
| 학습 자료 | [D-Fire LICENSE](https://github.com/gaia-solutions-on-demand/DFireDataset/blob/master/LICENSE) | 수집물 CC0와 개별 이미지 권리 미소유 설명을 구분. 학습 자료를 재배포하거나 독립 평가로 재사용하지 않음 |
| 개발 영상 6개 | manifest의 저작자·출처·CC0/BY/BY-SA 조건 | 원본 바이트 유지, 공개 Git에 영상 미포함. 영상/시연 파생물 공유 시 원본별 저작자·출처·라이선스·변경 표시 및 해당 SA 조건 확인 |
| 프로젝트 자체 | 현재 저장소에 LICENSE 없음 | 팀의 프로젝트 라이선스 합의가 필요. 이 작업에서 팀 코드 전체의 라이선스를 임의 지정하지 않음 |

설치 패키지 메타데이터도 확인했다(`runs/a01-source-check/package-licenses.json`). torchvision은 BSD, OpenCV는 Apache 2.0, psutil은 BSD-3-Clause 표기다. torch와 numpy는 여러 라이선스의 결합 표현이므로 단일 BSD로 축약하지 않는다. 전체 버전 목록은 AI lock을 기준으로 하며, 이 주요 패키지 표기는 전체 전이 의존성·동봉 코드의 법률 검토 완료를 뜻하지 않는다.

제출용 활용 내역에는 감지 모델·실행 라이브러리·학습 자료·개발 영상·개발 보조 AI(Codex/Fable)를 분리해서 기재한다. Bedrock은 이번 실행에 사용하지 않았으며 A05의 상황 설명 용도로 별도 기록한다. 검토 결과 PASS를 모델 성능 인증이나 라이선스 승인으로 표시하지 않는다.

## 4. 지원 서버에서 이어서 실행할 절차

대상 사양은 [D01 기록](../../deploy/README.md)의 Ubuntu 24.04.5 / t3.xlarge / 4 vCPU / GPU 없음이다. 이 PC에는 해당 SSH 설정이 없어서 서버 실행은 아직 못 했다. 호스트·사용자·키 경로를 확인하거나 담당자가 아래 절차를 실행해야 한다. 접속 정보·키는 공개 저장소에 넣지 않는다.

1. A01-1 #79가 통합된 develop의 검토된 커밋을 별도 작업 디렉터리에 받아 `git rev-parse HEAD`를 기록한다. 운영 서비스 디렉터리를 덮어쓰지 않는다.
2. `models/fire-smoke-yolov8n.pt`와 manifest의 `data/videos/` 원본 6개를 같은 상대 경로로 준비한다. 현재 PC의 검증된 원본을 팀 내부로 전달하거나 manifest의 원본 URL에서 확보한다. 실행 도구가 모두 SHA-256으로 확인한다.
3. 별도 Python 3.12 환경에서 기존 lock을 설치하고 아래 측정을 실행한다. 다른 패키지로 자동 대체하지 않는다.

```sh
python3.12 -m venv .venv-ai
.venv-ai/bin/python -m pip install -r requirements-ai.lock.txt
.venv-ai/bin/python -m tools.validate_ai_model --output runs/a01-server-640 --pace
```

Linux x86_64 / manylinux_2_39 / Python 3.12 대상 `uv pip compile`은 기존 39개 고정 버전을 해석했다. 결과는 `runs/a01-source-check/requirements-ai-linux-resolved.txt`에 있다. 이 검사는 Linux에서 설치·import·추론을 수행한 증거가 아니므로 서버 검증을 대체하지 않는다. 시스템 라이브러리 오류가 나면 오류를 기록하고 서버 담당자와 실행 환경을 맞춘다.

4. 생성된 summary·JSONL·실행 커밋·서버 사양을 함께 보존한다. 실제 클래스·검출 수, 완료 간격과 읽기 후 경과, 재생 지연·메모리를 확인한다. 3초 이상 공백/오래된 결과가 있으면 기본 설정의 적합성을 다시 판단한다. 네트워크 지연까지 포함한 유효기간 판정은 A02 실제 API 연결에서 확인한다.

## 5. 완료 상태

- 완료: 실제 두 클래스·해시·실행 환경 기록, 개발 6개 비교, 320/640/960 선택 근거, 로컬 재생 속도 측정, 주요 사용 조건·서버 인계 절차 정리.
- 대기: 팀 라이선스 결정, 지원 서버 실제 측정 및 그 결과를 반영한 최종 후보 채택.
- 별도 반영 완료: A02 #10 / PR #58 이벤트 연결, A03-1 #60 / PR #64 장애 처리, A04-1 #76 / PR #78 영상별 사건 집계. 각 기록은 [A02](a02-video-events.md), [A03-1](a03-input-failures.md), [A04-1](a04-event-evaluation.md)에 있다. A03 #12 평가 조건 고정·A04 #30 독립 평가는 계속 남아 있다.

## 6. 팀 연결 기준 — A01-1 #79

- 5번/Q01: manifest의 6개 원본과 파생 장면은 모두 development다. 이 자료의 인접 구간을 잘라 독립 평가로 옮기지 않는다. 실제 영상 전체를 검토한 독립 정답은 아직 제공되지 않았으며 [정답 형식 예제](../../data/expected/ai/evaluation.example.json)도 fixture다. 기존 4개 전달 ZIP과 현재 6개 목록을 혼동하지 않는다. 원본은 manifest의 URL·해시로 확보하고 사용 조건을 함께 확인한다.
- 2번/배포: AI lock과 별도 환경·ffprobe는 [A03-1 실행 조건](a03-input-failures.md)을 따른다. CPU 로컬 측정을 서버 성능으로 옮기지 않는다. 실제 Bedrock 설명은 A05 #41이며 개발 보조용 Claude 로그인과 다르다.
- 1·3·5번/통합: 현재 `data/space/wfi-v1.json`과 `wfi-geometry-v1.json`은 **WFI v3**다. `configs/ai.example.json`은 **TWO_ROUTE v1 / CAM-A / Z-A** 계약 시험용이므로 WFI 서버에 그대로 사용하지 않는다.
- WFI 연결 시 `/api/building`과 `/api/session`을 기준으로 로컬 AI 설정의 building_id·building_version·source_id·expected_zone_id를 함께 맞춘다. 현재 예는 `WFI / 3 / CAM-F2-CORR-W / F2-CORR-W`이며 수동 시연 매핑이다. 카메라 설치 위치와 관측 구역이 같다고 가정하지 않는다. 건물 버전 변경 후에는 다시 확인한다.
- WFI의 필수 감지기 12개와 arm 조건은 유지한다. AI 카메라 연결 하나만으로 전체 초기 관측이 충족되지 않는다. 운전 중 필수 관측이 끊기면 #65 정책대로 해당 구역을 제외해 경로를 계산한다. AI가 장애를 정상 관측으로 덮어쓰거나 자동 arm·reset·clear하지 않는다.
- 기존 A05 #41 설명 연결을 우선하고, 추가 A06 #73은 실제 프레임·검출 표시 데이터만 제공한다. 화면은 담당 3의 P06 #74, 위치 표시 기준은 담당 2의 #68과 연결한다. 3D·프론트의 별도 시점/화면 기능을 AI 작업에서 중복 구현하지 않는다.
