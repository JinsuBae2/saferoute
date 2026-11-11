# A06 실제 추론 미리보기 전송

관련: [#73](https://github.com/JinsuBae2/saferoute/issues/73), [A06-1 계약](a06-preview-contract.md), 화면 연결 [#74](https://github.com/JinsuBae2/saferoute/issues/74).

기존 AI 작업자의 실제 분석 프레임을 별도 프로세스에서 JPEG로 인코딩해 별도 미리보기 API로 전달한다. 관측 이벤트 전송이 성공한 뒤 미리보기 큐에 넣으며, 큐가 차거나 API가 느려도 관측 전송은 기다리지 않는다. 미리보기 기능은 선택 사항이다. 모델·임계값·경로·경보·명령/ACK·Bedrock을 바꾸지 않았다.

## 실행

기존 core 환경으로 제어기를 먼저 실행한 뒤 별도 터미널에서 다음 API를 실행한다. 시스템 의존성이나 새 패키지를 추가하지 않았다.

```sh
.venv/bin/python -m uvicorn preview_worker.app:create_app --factory --host 127.0.0.1 --port 8003 --workers 1 --limit-concurrency 16
```

제어기 기본 주소는 `http://127.0.0.1:8000`, 변경은 `SAFEROUTE_PREVIEW_CONTROLLER` 환경변수다. 제어기와 미리보기 API·AI 작업자는 같은 호스트의 로컬 HTTP로 연결한다. 주소는 localhost/127.0.0.1/::1만 허용하며 자격증명·경로·쿼리가 붙은 URL은 거부한다. 외부 공개 인증 서비스가 아니므로 바인딩도 loopback으로 유지한다. 다른 PC의 화면은 팀 SSH 터널을 사용한다.

실제 영상은 기존 AI 환경과 확보한 개발 가중치/영상으로 실행한다.

```sh
.venv-ai/bin/python -m ai_worker --config configs/ai.example.json --video data/videos/candle-and-match.ogv --preview-url http://127.0.0.1:8003
```

Windows는 각 환경의 `Scripts/python.exe`를 사용한다. `--preview-url`을 생략하면 JPEG 인코딩·전송 프로세스를 만들지 않는다. 기존 VIDEO_AI 매핑·원본 해시·새 실행/관측원 소유 검사와 AI 로그 규칙을 그대로 따른다. 현재 worker의 `ai-predictions.jsonl`은 한 실행에서 한 생산자가 소유하므로 여러 AI worker의 같은 run 동시 실행을 이번 작업이 지원한다고 해석하지 않는다. 다른 카메라의 영상으로 바꾸려면 기존 worker를 종료하고 reset·매핑된 새 설정으로 재시작한다.

## 화면 담당 조회

1. 현재 제어 `/api/state`에서 run_id와 건물 버전을 얻고 선택한 VIDEO_AI source_id로 `GET /api/previews/{source_id}?run_id=...`를 조회한다.
2. READY의 frame_id로 `GET /api/preview-frames/{frame_id}.jpg?run_id=...&source_id=...`를 조회한다. JPEG의 `X-Preview-Frame-Id`가 같아야 한다. 두 응답 모두 no-store다. 이미지 수신 뒤에도 현재 실행·카메라 선택을 다시 대조한다.
3. 원본 width/height에 대한 정규화 xyxy를 실제 이미지 내용 영역에 그린다. JPEG는 최대 변 640, 품질 80으로 축소 인코딩하며 크롭·회전·상자 그리기를 하지 않는다. 반올림한 축소 픽셀 크기는 JPEG의 실제 크기를 사용한다.
4. A06-1의 서버 시각·왕복 시간·이미지 수신 시간을 차감한 만료 타이머를 적용한다. 기한·실행·카메라가 바뀌거나 READY가 아니면 이미지/상자를 함께 지운다. 다음 프레임으로 교체된 예전 frame_id의 404는 정상이며 새 메타데이터를 다시 조회한다.

프론트 개발 프록시/배포 리버스 프록시에서는 위 두 조회 경로만 8003으로 연결한다. `/internal/preview`는 로컬 생산자용이므로 화면·외부에 프록시하지 않는다. 이번 PR은 관제 UI·3D 카메라 선택을 구현하지 않으며 담당 3이 #74에서 연결한다.

예시 응답과 좌표는 `data/contracts/valid.json`의 `preview_*`와 생성 TypeScript에 있다. 실제 조회의 409 RUN_MISMATCH는 reset 뒤 옛 실행, 404 UNKNOWN_SOURCE는 미등록/VIDEO_AI가 아닌 관측원, 404 PREVIEW_FRAME_UNAVAILABLE은 교체·만료·폐기 프레임, 503 CONTROLLER_NOT_READY는 현재 제어 상태를 확인하지 못한 경우다. 기존 ErrorResponse 형식이며 JSON 오류에 전체 내부 예외·경로·자격증명을 넣지 않는다.

## 격리·상태·제한

- AI 프로세스는 크기 1의 pending 큐에 put_nowait만 한다. 자식 하나가 JPEG 인코딩·HTTP 전송을 담당한다. 인코딩 중인 프레임 외 대기는 최대 하나이며 이후 입력은 버린다. 1,600만 픽셀을 넘는 입력은 미리보기에서 제외한다. 부모가 대기 없이 넘긴 프레임은 이후 변경하지 않는다.
- 원본 좌표를 원본 너비/높이로 나누고 화면 범위로 자른다. 잘못된 좌표/인코딩 실패는 PREVIEW_FAILED다. confidence·클래스는 원래 분석 결과이며 표시 상자 개수로 경보를 다시 판정하지 않는다.
- 로컬 업로드는 0.5초 HTTP timeout, 자동 재시도 없음, 단일 진행 요청이다. JSON 요청 본문은 최대 3,000,000바이트·수신 최대 1초다. 업로드 도중 연결을 끊은 경우도 처리하며 ASGI 예외를 반복 출력하지 않는다. 서비스는 등록된 관측원별 최신 JPEG 하나만 보존한다.
- 내부 전송 순번과 frame_index가 이전보다 높아야 한다. 지연된 요청이 최신 결과를 덮어쓰지 않는다. 현재 세션·건물·VIDEO_AI 등록과 유효기간을 확인한 뒤 저장/조회한다. 이전 실행은 자동으로 새 실행에 재귀속하지 않는다.
- worker EOF는 EOF, 읽기 실패는 DECODE_FAILED, 추론/검출 오류는 INFERENCE_FAILED, 관측 전송 실패는 DELIVERY_FAILED, 사용자 중단은 OPERATOR_STOPPED를 전달한다. terminal 상태 뒤 같은 실행의 늦은 프레임을 거부한다. controller 연결 실패는 캐시 이미지를 비우되 순번·종료 기록은 유지한다.
- 자식 종료 대기는 AI 작업이 끝난 뒤 최대 2초, 이어 terminate/join 최대 1초다. 프로세스 강제 종료나 API 단절로 종료 알림 자체가 전달되지 않으면 마지막 이미지는 원래 기한까지만 유효하고 이후 STALE이다. EOF를 받았다고 꾸미지 않는다. 서비스/화면 단절은 관측 전송이나 경보 해제를 유발하지 않는다.
- 전송 자식은 SIGINT를 무시하고 부모가 전달한 종료 사유로 마무리한다. 부모의 Ctrl+C가 OPERATOR_STOPPED 경로를 실행하며, 자식이 같은 SIGINT로 먼저 죽어 알림을 잃지 않게 한다. 자식 부팅 전 강제 종료·알림 전송 실패는 위 만료 규칙을 따른다.
- READY의 generated_at은 조회 시점이고 frame의 취득/만료 시각은 그대로다. 이 둘은 다른 의미다. 미리보기와 제어 API의 스냅샷 사이에 reset이 발생할 수 있어 화면도 표시 직전 현재 실행을 확인해야 한다.

worker 로그의 prediction.preview_frame_id로 프레임을 분석 기록에 연결한다. `preview_finished.dropped_pending_frames`는 큐/자식 상태/입력 크기로 게시를 생략한 수이며 네트워크 실패 전체 개수는 아니다. 전송 오류 유형은 작업자의 stderr에 남는다. JPEG와 실제 영상은 Git에 저장하지 않는다.

## 검증과 재현

```sh
.venv/bin/python -m pytest tests/test_preview_contract.py tests/test_preview_service.py tests/test_ai_worker.py -q
.venv-ai/bin/python -m tools.validate_preview --output runs/preview-new --assets-root .
```

실제 검증기는 새 출력 폴더를 요구하고 개발 manifest의 모델·영상 SHA-256을 확인한다. 자체 제어기/미리보기 API/실제 AI worker로 정상 후보·불꽃·연기를 실행한다. 내려받은 JPEG를 같은 원본 프레임의 재인코딩 결과와 바이트 대조하고 상자·취득/완료/영상 시각·프레임 ID를 AI 로그와 맞춘다. 2초 업로드 지연 및 연결 거부에서도 실제 관측 payload가 모두 수신됐는지 확인한다. 생성한 프로세스를 종료한다.

실측 수치와 소스/원본 기록 해시는 [개발 실측 JSON](../../deploy/resource-checks/2026-11-10-preview-delivery.json)에 기록한다. 최초 actual01에서는 영상/관측 대조는 통과했으나 느린 업로더의 연결 중단에서 미처리 ClientDisconnect 로그가 발생했다. 이를 정상 오류 응답으로 처리하는 회귀 검사를 추가하고 actual02로 다시 실행했다. 이후 Fable 검토에서 제어기 단절 뒤 EOF/오류 상태 보존과 공통 HTTP 오류 상태표 누락을 수정하고, 복구 회귀 검사·actual03 실제 실행으로 재검증했다. 두 번째 수정에서 자식의 SIGINT 처리를 보강하고 별도 Python 프로세스에 SIGINT를 주입해 OPERATOR_STOPPED/null 프레임 전송 경로와 무예외 종료를 확인했다(HTTP는 모의 수신이며 사용자 콘솔 전체에 Ctrl+C를 보내지 않음). 실제 영상 5개 시험도 actual04로 재수행했으며 현재 JSON은 actual04 소스에 대응한다. 실패 흔적을 독립 성능 통과로 바꾸지 않는다.

읽기/추론 실패·동일 실행의 두 등록 카메라 분리·만료·reset·과거 순번·잘못된 입력은 자동 주입 시험이다. 실제 장비 두 대/실시간 CCTV/브라우저 화면·WFI 전체 통합·지원 서버 동시 부하·독립 감지 정확도 검증은 아니다. 원본 AI 모델과 임계값 후보 선정은 #9/#12, 화면 구현은 #74에서 계속한다.
